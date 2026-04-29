const Submission = require('../models/Submission');
const { sanitizeFolderSegment, uploadTextAsset, uploadToCloudinary } = require('../services/cloudStorage');
const {
  buildOAuthConsentUrl,
  exchangeOAuthCode,
  exchangeDeviceCode,
  saveRefreshTokenToEnv,
  startDeviceAuthorization,
  uploadZipToDrive,
} = require('../services/googleDriveService');
const {
  buildCombinedResult,
  buildCombinedTranscript,
  buildQuestionResult,
  buildReport,
  buildStructuredSubmissionJson,
  normalizeTranscript,
} = require('../services/mlService');
const { createZip } = require('../services/zipService');

function getUserId(sessionId, userId) {
  return userId || sessionId;
}

function getParticipantFolder(user, fallback) {
  return `schizophrenia-data-collection/${sanitizeFolderSegment(user?.name || fallback)}`;
}

function getParticipantFileName(submission, extension) {
  const participant = sanitizeFolderSegment(submission.user?.name || submission.userId || submission.sessionId);
  const session = sanitizeFolderSegment(submission.sessionId || submission._id || 'session');
  return `${participant}-${session}-final-report.${extension}`;
}

function extensionFromAudio(response) {
  const mimeType = response?.audioMimeType || '';
  const audioUrl = response?.audioUrl || '';
  if (mimeType.includes('wav') || audioUrl.toLowerCase().includes('.wav')) return 'wav';
  return 'wav';
}

async function audioZipFiles(submission, currentAudio) {
  const responses = Object.fromEntries(submission.responses || []);
  const files = [];

  for (const questionId of ['q1', 'q2', 'q3']) {
    const response = responses[questionId];
    if (!response) continue;

    const name = `audios/${questionId}.${extensionFromAudio(response)}`;
    if (currentAudio?.questionId === questionId && currentAudio.buffer) {
      files.push({ name, content: currentAudio.buffer });
      continue;
    }

    if (!response.audioUrl) continue;
    try {
      const audioResponse = await fetch(response.audioUrl);
      if (!audioResponse.ok) throw new Error(`HTTP ${audioResponse.status}`);
      files.push({ name, content: Buffer.from(await audioResponse.arrayBuffer()) });
    } catch (audioError) {
      console.warn(`Audio download skipped for ${questionId}:`, audioError.message);
    }
  }

  return files;
}

async function buildFinalReportZip(submission, currentAudio) {
  const structuredSubmission = buildStructuredSubmissionJson(submission);
  const structuredJson = JSON.stringify(structuredSubmission, null, 2);
  const zipFileName = getParticipantFileName(submission, 'zip');
  const audioFiles = await audioZipFiles(submission, currentAudio);
  const zipEntries = [
    {
      name: 'final-report.json',
      content: structuredJson,
    },
    ...audioFiles,
  ];
  const zipBuffer = createZip([
    ...zipEntries,
  ]);
  console.log(`Built ZIP ${zipFileName} with entries: ${zipEntries.map((entry) => entry.name).join(', ')}`);

  return { structuredSubmission, structuredJson, zipFileName, zipBuffer, zipEntries: zipEntries.map((entry) => entry.name) };
}

async function uploadFinalReportZipToDrive(submission, zipBuffer, zipFileName) {
  try {
    const driveFile = await uploadZipToDrive({
      buffer: zipBuffer,
      fileName: zipFileName,
    });
    submission.zipGoogleDriveFileId = driveFile.id;
    submission.zipGoogleDriveUrl = driveFile.webViewLink || driveFile.webContentLink;
    submission.zipFileUrl = submission.zipFileUrl || submission.zipGoogleDriveUrl;
    submission.zipUploadError = undefined;
    console.log(`Google Drive ZIP uploaded: ${zipFileName} (${driveFile.id})`);
    return driveFile;
  } catch (uploadError) {
    console.warn('Google Drive upload for ZIP failed (report still saved to DB):', uploadError.message);
    submission.zipUploadError = uploadError.message;
    return null;
  }
}

async function findOrCreateSubmission({ sessionId, userId, user }) {
  return Submission.findOneAndUpdate(
    { sessionId },
    {
      $setOnInsert: {
        sessionId,
        userId: getUserId(sessionId, userId),
      },
      $set: {
        ...(user ? { user } : {}),
      },
    },
    { returnDocument: 'after', upsert: true, setDefaultsOnInsert: true }
  );
}

async function saveProgress(req, res, next) {
  try {
    const { sessionId, user, responses, status } = req.body;
    const userId = req.user?._id?.toString() || req.body.userId;
    if (!sessionId) return res.status(400).json({ message: 'sessionId is required.' });

    const submission = await findOrCreateSubmission({ sessionId, userId, user });
    if (responses && typeof responses === 'object') {
      Object.entries(responses).forEach(([key, value]) => {
        submission.responses.set(key, value);
      });
    }
    submission.status = status || submission.status || 'in-progress';
    await submission.save();

    res.json({ message: 'Progress saved.', submission });
  } catch (error) {
    next(error);
  }
}

async function saveVoiceResponse(req, res, next) {
  try {
    const { sessionId, questionId, question, rawTranscript = '', durationMs = 0 } = req.body;
    const userId = req.user?._id?.toString() || req.body.userId;
    const user = {
      name: req.body.userName || req.body['user[name]'],
      contact: req.body.userContact || req.body['user[contact]'],
    };
    if (!sessionId) return res.status(400).json({ message: 'sessionId is required.' });
    if (!questionId || !question) return res.status(400).json({ message: 'questionId and question are required.' });
    if (!req.file) return res.status(400).json({ message: 'Recorded audio file is required.' });
    const isWavUpload = req.file.mimetype?.includes('wav') || req.file.originalname?.toLowerCase().endsWith('.wav');
    if (!isWavUpload) {
      return res.status(400).json({ message: 'Recorded audio must be uploaded as a WAV file.' });
    }

    const cloudFile = await uploadToCloudinary({
      buffer: req.file.buffer,
      fileName: req.file.originalname || `${questionId}.wav`,
      mimeType: req.file.mimetype || 'audio/wav',
      folder: getParticipantFolder(user, getUserId(sessionId, userId)),
    });

    const normalizedTranscript = normalizeTranscript(rawTranscript);
    const result = buildQuestionResult({
      rawTranscript,
      normalizedTranscript,
      fileName: req.file.originalname || `${questionId}.wav`,
    });
    const response = {
      questionId,
      question,
      audioUrl: cloudFile.url,
      audioPublicId: cloudFile.publicId,
      audioMimeType: req.file.mimetype,
      audioSize: cloudFile.bytes || req.file.size,
      durationMs: Number(durationMs) || 0,
      transcripts: {
        raw: rawTranscript,
        normalized: normalizedTranscript,
      },
      result,
      savedAt: new Date(),
    };

    const submission = await findOrCreateSubmission({ sessionId, userId, user });
    submission.responses.set(questionId, response);
    submission.combinedTranscript = buildCombinedTranscript(submission);
    submission.combinedResult = buildCombinedResult(submission);

    const participantFolder = getParticipantFolder(submission.user || user, getUserId(sessionId, userId));
    const transcriptAsset = await uploadTextAsset({
      text: submission.combinedTranscript,
      fileName: 'combined-transcript.txt',
      folder: participantFolder,
    });
    const combinedResultAsset = await uploadTextAsset({
      text: JSON.stringify(submission.combinedResult, null, 2),
      fileName: 'combined-result.json',
      folder: participantFolder,
      mimeType: 'application/json',
    });
    submission.combinedTranscriptUrl = transcriptAsset.url;
    submission.combinedResultUrl = combinedResultAsset.url;
    submission.status = submission.responses.size >= 3 ? 'completed' : 'in-progress';

    const { zipFileName, zipBuffer, zipEntries } = await buildFinalReportZip(submission, {
      questionId,
      buffer: req.file.buffer,
    });
    await uploadFinalReportZipToDrive(submission, zipBuffer, zipFileName);

    await submission.save();

    res.json({ message: 'Voice response saved.', response, zipEntries, submission });
  } catch (error) {
    next(error);
  }
}

async function uploadZip(req, res, next) {
  try {
    const { sessionId } = req.body;
    const userId = req.user?._id?.toString() || req.body.userId;
    if (!sessionId) return res.status(400).json({ message: 'sessionId is required.' });
    if (!req.file) return res.status(400).json({ message: 'ZIP file is required.' });

    const cloudFile = await uploadToCloudinary({
      buffer: req.file.buffer,
      fileName: req.file.originalname || 'submission.zip',
      mimeType: req.file.mimetype || 'application/zip',
      folder: getParticipantFolder(null, getUserId(sessionId, userId)),
    });

    const submission = await findOrCreateSubmission({ sessionId, userId });
    submission.zipFileUrl = cloudFile.url;
    await submission.save();

    res.json({ message: 'ZIP uploaded to cloud storage.', zipFileUrl: cloudFile.url, submission });
  } catch (error) {
    next(error);
  }
}

function googleDriveAuth(req, res, next) {
  try {
    res.redirect(buildOAuthConsentUrl());
  } catch (error) {
    next(error);
  }
}

async function googleDriveOAuthCallback(req, res, next) {
  try {
    const { code, error } = req.query;
    if (error) return res.status(400).send(`Google Drive authorization failed: ${error}`);
    if (!code) return res.status(400).send('Google Drive authorization code is missing.');

    const tokenPayload = await exchangeOAuthCode(code);
    if (!tokenPayload.refresh_token) {
      return res.status(400).send('Google did not return a refresh token. Revisit /api/google-drive/auth and approve access again.');
    }

    saveRefreshTokenToEnv(tokenPayload.refresh_token);
    res.send('Google Drive authorization saved. Restart the backend once, then generate the report again.');
  } catch (callbackError) {
    next(callbackError);
  }
}

async function googleDriveDeviceAuth(req, res, next) {
  try {
    const devicePayload = await startDeviceAuthorization();
    res.json({
      message: 'Open verification_url, enter user_code, approve Drive access, then POST device_code to /api/google-drive/device-token.',
      verification_url: devicePayload.verification_url,
      verification_url_complete: devicePayload.verification_url_complete,
      user_code: devicePayload.user_code,
      device_code: devicePayload.device_code,
      expires_in: devicePayload.expires_in,
      interval: devicePayload.interval,
    });
  } catch (error) {
    next(error);
  }
}

async function googleDriveDeviceToken(req, res, next) {
  try {
    const { deviceCode, device_code: deviceCodeSnake } = req.body;
    const selectedDeviceCode = deviceCode || deviceCodeSnake;
    if (!selectedDeviceCode) return res.status(400).json({ message: 'deviceCode is required.' });

    const tokenPayload = await exchangeDeviceCode(selectedDeviceCode);
    if (!tokenPayload.refresh_token) {
      return res.status(400).json({ message: 'Google did not return a refresh token. Start device authorization again and approve access.' });
    }

    saveRefreshTokenToEnv(tokenPayload.refresh_token);
    res.json({ message: 'Google Drive authorization saved. Restart the backend once, then generate the report again.' });
  } catch (error) {
    if (['authorization_pending', 'slow_down'].includes(error.googleError)) {
      return res.status(428).json({ message: 'Google authorization is not completed yet. Approve access, then retry this request.' });
    }
    next(error);
  }
}

async function submitData(req, res, next) {
  try {
    const { sessionId, user } = req.body;
    const userId = req.user?._id?.toString() || req.body.userId;
    if (!sessionId) return res.status(400).json({ message: 'sessionId is required.' });
    const submission = await findOrCreateSubmission({ sessionId, userId, user });
    submission.status = 'completed';
    await submission.save();
    res.json({ message: 'Data submitted.', submission });
  } catch (error) {
    next(error);
  }
}

async function generateReport(req, res, next) {
  try {
    const { sessionId, submissionId } = req.body;
    const query = submissionId ? { _id: submissionId } : { sessionId };
    if (req.user?.role !== 'admin') query.userId = req.user?._id?.toString();
    const submission = await Submission.findOne(query);
    if (!submission) return res.status(404).json({ message: 'Submission not found.' });

    // Check that there are responses to generate a report from
    const responseCount = submission.responses ? submission.responses.size : 0;
    if (responseCount === 0) {
      return res.status(400).json({ message: 'No voice responses found for this submission.' });
    }

    submission.report = buildReport(submission);
    submission.status = 'report-generated';
    const { structuredSubmission, structuredJson, zipFileName, zipBuffer, zipEntries } = await buildFinalReportZip(submission);

    // Try uploading to Cloudinary but don't fail if it doesn't work
    try {
      const reportAsset = await uploadTextAsset({
        text: structuredJson,
        fileName: 'final-report.json',
        folder: getParticipantFolder(submission.user, submission.userId),
        mimeType: 'application/json',
      });
      submission.reportUrl = reportAsset.url;
    } catch (uploadError) {
      console.warn('Cloudinary upload for report failed (report still saved to DB):', uploadError.message);
    }

    try {
      const zipAsset = await uploadToCloudinary({
        buffer: zipBuffer,
        fileName: zipFileName,
        mimeType: 'application/zip',
        folder: getParticipantFolder(submission.user, submission.userId),
        resourceType: 'raw',
      });
      submission.zipFileUrl = zipAsset.url;
      submission.zipCloudinaryUrl = zipAsset.url;
    } catch (uploadError) {
      console.warn('Cloudinary upload for ZIP failed (ZIP can still be uploaded to Drive):', uploadError.message);
      submission.zipUploadError = uploadError.message;
    }

    await uploadFinalReportZipToDrive(submission, zipBuffer, zipFileName);

    await submission.save();

    res.json({
      message: 'Report generated.',
      report: submission.report,
      finalReportJson: structuredSubmission,
      zipFileUrl: submission.zipFileUrl,
      zipGoogleDriveUrl: submission.zipGoogleDriveUrl,
      zipUploadError: submission.zipUploadError,
      zipEntries,
      submission,
    });
  } catch (error) {
    next(error);
  }
}

async function getReport(req, res, next) {
  try {
    const query = { _id: req.params.id };
    if (req.user?.role !== 'admin') query.userId = req.user?._id?.toString();
    const submission = await Submission.findOne(query);
    if (!submission) return res.status(404).json({ message: 'Submission not found.' });
    if (!submission.report) return res.status(404).json({ message: 'Report has not been generated yet.' });

    // Convert Mongoose Map to a plain object for JSON serialization
    const responses = submission.responses instanceof Map
      ? Object.fromEntries(submission.responses)
      : (submission.responses || {});

    res.json({
      submissionId: submission._id,
      user: submission.user,
      responses,
      combinedTranscript: submission.combinedTranscript,
      combinedTranscriptUrl: submission.combinedTranscriptUrl,
      combinedResult: submission.combinedResult,
      combinedResultUrl: submission.combinedResultUrl,
      reportUrl: submission.reportUrl,
      zipFileUrl: submission.zipFileUrl,
      zipGoogleDriveUrl: submission.zipGoogleDriveUrl,
      zipUploadError: submission.zipUploadError,
      report: submission.report,
    });
  } catch (error) {
    next(error);
  }
}

async function getAdminUsers(req, res, next) {
  try {
    const submissions = await Submission.find().sort({ updatedAt: -1 }).lean();
    // .lean() returns plain JS objects, converting Mongoose Maps to regular objects
    // Ensure responses are always plain objects
    const serialized = submissions.map((sub) => ({
      ...sub,
      responses: sub.responses && typeof sub.responses === 'object'
        ? (sub.responses instanceof Map ? Object.fromEntries(sub.responses) : sub.responses)
        : {},
    }));
    res.json(serialized);
  } catch (error) {
    next(error);
  }
}

async function getMySubmissions(req, res, next) {
  try {
    const submissions = await Submission.find({ userId: req.user._id.toString() }).sort({ updatedAt: -1 }).lean();
    const serialized = submissions.map((sub) => ({
      ...sub,
      responses: sub.responses && typeof sub.responses === 'object'
        ? (sub.responses instanceof Map ? Object.fromEntries(sub.responses) : sub.responses)
        : {},
    }));
    res.json(serialized);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  saveProgress,
  saveVoiceResponse,
  submitData,
  uploadZip,
  googleDriveAuth,
  googleDriveOAuthCallback,
  googleDriveDeviceAuth,
  googleDriveDeviceToken,
  generateReport,
  getReport,
  getAdminUsers,
  getMySubmissions,
};
