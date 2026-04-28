const Submission = require('../models/Submission');
const { sanitizeFolderSegment, uploadTextAsset, uploadToCloudinary } = require('../services/cloudStorage');
const {
  buildCombinedResult,
  buildCombinedTranscript,
  buildQuestionResult,
  buildReport,
  normalizeTranscript,
} = require('../services/mlService');

function getUserId(sessionId, userId) {
  return userId || sessionId;
}

function getParticipantFolder(user, fallback) {
  return `schizophrenia-data-collection/${sanitizeFolderSegment(user?.name || fallback)}`;
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
    { new: true, upsert: true, setDefaultsOnInsert: true }
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

    const cloudFile = await uploadToCloudinary({
      buffer: req.file.buffer,
      fileName: req.file.originalname || `${questionId}.webm`,
      mimeType: req.file.mimetype || 'audio/webm',
      folder: getParticipantFolder(user, getUserId(sessionId, userId)),
    });

    const normalizedTranscript = normalizeTranscript(rawTranscript);
    const result = buildQuestionResult({
      rawTranscript,
      normalizedTranscript,
      fileName: req.file.originalname || `${questionId}.webm`,
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
    await submission.save();

    res.json({ message: 'Voice response saved.', response, submission });
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

    submission.report = buildReport(submission);
    const reportAsset = await uploadTextAsset({
      text: JSON.stringify(submission.report, null, 2),
      fileName: 'final-report.json',
      folder: getParticipantFolder(submission.user, submission.userId),
      mimeType: 'application/json',
    });
    submission.reportUrl = reportAsset.url;
    submission.status = 'report-generated';
    await submission.save();

    res.json({ message: 'Report generated.', report: submission.report, submission });
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
    res.json({
      submissionId: submission._id,
      user: submission.user,
      responses: Object.fromEntries(submission.responses || []),
      combinedTranscript: submission.combinedTranscript,
      combinedTranscriptUrl: submission.combinedTranscriptUrl,
      combinedResult: submission.combinedResult,
      combinedResultUrl: submission.combinedResultUrl,
      reportUrl: submission.reportUrl,
      report: submission.report,
    });
  } catch (error) {
    next(error);
  }
}

async function getAdminUsers(req, res, next) {
  try {
    const submissions = await Submission.find().sort({ updatedAt: -1 });
    res.json(submissions);
  } catch (error) {
    next(error);
  }
}

async function getMySubmissions(req, res, next) {
  try {
    const submissions = await Submission.find({ userId: req.user._id.toString() }).sort({ updatedAt: -1 });
    res.json(submissions);
  } catch (error) {
    next(error);
  }
}

module.exports = {
  saveProgress,
  saveVoiceResponse,
  submitData,
  uploadZip,
  generateReport,
  getReport,
  getAdminUsers,
  getMySubmissions,
};
