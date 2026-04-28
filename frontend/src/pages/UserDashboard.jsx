import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CircleStop, Eye, Mic, RotateCcw, Save, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { voiceQuestions } from '../data/voiceQuestions';

function makeSessionId(userId) {
  const key = `sdc-session-id-${userId}`;
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const next = `session-${userId}-${Date.now()}`;
  localStorage.setItem(key, next);
  return next;
}

function createSpeechRecognizer(onText) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const recognizer = new SpeechRecognition();
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.lang = 'en-US';
  recognizer.onresult = (event) => {
    const text = Array.from(event.results)
      .map((result) => result[0]?.transcript || '')
      .join(' ');
    onText(text);
  };
  return recognizer;
}

export default function UserDashboard({ currentUser }) {
  const navigate = useNavigate();
  const sessionId = useMemo(() => makeSessionId(currentUser?.id), [currentUser?.id]);
  const mediaRecorderRef = useRef(null);
  const speechRecognizerRef = useRef(null);
  const chunksRef = useRef([]);
  const recordingStartedAtRef = useRef(null);
  const [durationMs, setDurationMs] = useState(0);

  const [stepIndex, setStepIndex] = useState(0);
  const [user, setUser] = useState({ name: currentUser?.name || '', contact: currentUser?.email || '' });
  const [isRecording, setIsRecording] = useState(false);
  const [audioBlob, setAudioBlob] = useState(null);
  const [recordingStopped, setRecordingStopped] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [savedResponses, setSavedResponses] = useState({});
  const [submissionId, setSubmissionId] = useState(localStorage.getItem('sdc-submission-id'));
  const [loadingAction, setLoadingAction] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [initialLoading, setInitialLoading] = useState(true);

  const currentQuestion = voiceQuestions[stepIndex];
  const hasAllResponses = Object.keys(savedResponses).length === voiceQuestions.length;

  // Load existing submission data from the backend on mount so saved
  // responses are retained across page refreshes / component remounts.
  useEffect(() => {
    async function loadExistingSubmission() {
      try {
        // Try loading from the stored submissionId first
        const storedId = localStorage.getItem('sdc-submission-id');
        if (storedId) {
          try {
            const response = await api.get(`/get-report/${storedId}`);
            const data = response.data;
            if (data.responses && typeof data.responses === 'object') {
              setSavedResponses(data.responses);
            }
            setSubmissionId(storedId);
            return;
          } catch {
            // Report may not exist yet — fall through to try my-submissions
          }
        }

        // Fall back to loading from my-submissions
        const response = await api.get('/my-submissions');
        const submissions = response.data;
        if (submissions && submissions.length > 0) {
          // Find the submission matching our current sessionId, or use the latest
          const matching = submissions.find((s) => s.sessionId === sessionId) || submissions[0];
          if (matching) {
            const responses = matching.responses || {};
            // Mongoose Maps are serialized as objects — handle both formats
            const normalizedResponses = {};
            for (const [key, value] of Object.entries(responses)) {
              if (value && (value.audioUrl || value.questionId)) {
                normalizedResponses[key] = value;
              }
            }
            if (Object.keys(normalizedResponses).length > 0) {
              setSavedResponses(normalizedResponses);
            }
            if (matching._id) {
              setSubmissionId(matching._id);
              localStorage.setItem('sdc-submission-id', matching._id);
            }
          }
        }
      } catch (loadError) {
        console.warn('Could not load existing submission:', loadError.message);
        // Non-critical — user can still record new responses
      } finally {
        setInitialLoading(false);
      }
    }

    loadExistingSubmission();
  }, [sessionId]);

  // Reset per-question recording state when switching steps
  useEffect(() => {
    // Stop any ongoing recording when switching questions
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      speechRecognizerRef.current?.stop();
      setIsRecording(false);
    }

    // Reset recording-related state for the new question
    setAudioBlob(null);
    setRecordingStopped(false);
    setTranscript('');
    setDurationMs(0);
    setError('');
    setStatus('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepIndex]);

  async function startRecording() {
    setError('');
    setStatus('');
    setAudioBlob(null);
    setRecordingStopped(false);
    setTranscript('');

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      chunksRef.current = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        setAudioBlob(new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' }));
        setDurationMs(recordingStartedAtRef.current ? Date.now() - recordingStartedAtRef.current : 0);
        stream.getTracks().forEach((track) => track.stop());
      };
      recorder.start();
      recordingStartedAtRef.current = Date.now();
      mediaRecorderRef.current = recorder;

      const recognizer = createSpeechRecognizer(setTranscript);
      speechRecognizerRef.current = recognizer;
      recognizer?.start();
      setIsRecording(true);
    } catch (recordingError) {
      setError(recordingError.message || 'Microphone permission was denied.');
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    speechRecognizerRef.current?.stop();
    setIsRecording(false);
    setRecordingStopped(true);
  }

  function rerecord() {
    setAudioBlob(null);
    setTranscript('');
    setDurationMs(0);
    setRecordingStopped(false);
    setError('');
    setStatus('');
  }

  async function saveAndNext() {
    if (!audioBlob) {
      setError('Record an answer before saving this question.');
      return;
    }

    setLoadingAction('save');
    setError('');
    setStatus('');

    try {
      const payload = new FormData();
      payload.append('sessionId', sessionId);
      payload.append('userName', user.name);
      payload.append('userContact', user.contact);
      payload.append('questionId', currentQuestion.id);
      payload.append('question', currentQuestion.text);
      payload.append('rawTranscript', transcript);
      payload.append('durationMs', String(durationMs));
      payload.append('audio', audioBlob, `${currentQuestion.id}-${Date.now()}.webm`);

      const response = await api.post('/upload-voice-response', payload);
      const savedId = response.data.submission?._id;
      if (savedId) {
        setSubmissionId(savedId);
        localStorage.setItem('sdc-submission-id', savedId);
      }
      setSavedResponses((current) => ({ ...current, [currentQuestion.id]: response.data.response }));
      setAudioBlob(null);
      setTranscript('');
      setRecordingStopped(false);
      setDurationMs(0);
      setStatus('Audio, transcripts, and question result saved.');

      // Move to next unanswered question, or stay on last
      const nextIndex = Math.min(stepIndex + 1, voiceQuestions.length - 1);
      if (nextIndex !== stepIndex) {
        setStepIndex(nextIndex);
      }
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to save this voice response.');
    } finally {
      setLoadingAction('');
    }
  }

  async function generateReport() {
    if (!submissionId) {
      setError('Save at least one response before generating a report.');
      return;
    }

    setLoadingAction('generate');
    setError('');
    try {
      const response = await api.post('/generate-report', { submissionId });
      setSubmissionId(response.data.submission?._id || submissionId);
      setStatus('Report generated from saved voice responses.');
      navigate(`/report/${response.data.submission?._id || submissionId}`);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to generate report.');
    } finally {
      setLoadingAction('');
    }
  }

  // Check if the current question already has a saved response
  const currentQuestionSaved = savedResponses[currentQuestion?.id];

  if (initialLoading) {
    return (
      <main className="page">
        <p className="inline-status">Loading your session...</p>
      </main>
    );
  }

  return (
    <main className="page">
      <header className="page-header">
        <div>
          <p className="eyebrow">User Dashboard</p>
          <h1>Schizophrenia Data Collection System</h1>
          <p>Answer three voice prompts. Each saved step stores one cloud audio URL, two transcripts, and one result.</p>
        </div>
        <button className="secondary" type="button" onClick={() => submissionId && navigate(`/report/${submissionId}`)}>
          <Eye size={18} />
          View Report
        </button>
      </header>

      <section className="form-panel profile-panel">
        <label className="field">
          <span>Participant name</span>
          <input value={user.name} onChange={(event) => setUser((current) => ({ ...current, name: event.target.value }))} />
        </label>
        <label className="field">
          <span>Contact or study ID</span>
          <input value={user.contact} onChange={(event) => setUser((current) => ({ ...current, contact: event.target.value }))} />
        </label>
      </section>

      <div className="stepper three">
        {voiceQuestions.map((question, index) => (
          <button
            key={question.id}
            className={index === stepIndex ? 'active' : ''}
            type="button"
            onClick={() => setStepIndex(index)}
          >
            {index + 1}
            <span>{savedResponses[question.id] ? '✓ Saved' : 'Pending'}</span>
          </button>
        ))}
      </div>

      <section className="form-panel recorder-panel">
        <div className="panel-heading">
          <h2>Question {stepIndex + 1}</h2>
          <p>{currentQuestion.text}</p>
        </div>

        {/* Show previously saved response info if available */}
        {currentQuestionSaved && !audioBlob && !isRecording && (
          <div className="saved-response-info">
            <p className="success">✓ This question has been saved.</p>
            {currentQuestionSaved.audioUrl && (
              <audio controls src={currentQuestionSaved.audioUrl} />
            )}
            {currentQuestionSaved.transcripts?.raw && (
              <div className="transcript-panel">
                <span>Saved transcript</span>
                <p>{currentQuestionSaved.transcripts.raw}</p>
              </div>
            )}
            <p className="inline-status">You can re-record to replace this response.</p>
          </div>
        )}

        <div className="recorder-controls">
          {!isRecording ? (
            <button className={recordingStopped ? 'secondary disabled-look' : 'primary'} type="button" onClick={startRecording} disabled={recordingStopped}>
              <Mic size={18} />
              {currentQuestionSaved && !recordingStopped ? 'Re-record' : 'Start Recording'}
            </button>
          ) : (
            <button type="button" onClick={stopRecording}>
              <CircleStop size={18} />
              Stop Recording
            </button>
          )}
          {recordingStopped && (
            <button className="secondary" type="button" onClick={rerecord}>
              <RotateCcw size={18} />
              Re-record
            </button>
          )}
          <span className={isRecording ? 'recording-dot active' : 'recording-dot'} />
        </div>

        <div className="transcript-panel">
          <span>Live transcript</span>
          <p>{transcript || 'Transcript will appear here when browser speech recognition is available.'}</p>
        </div>

        {audioBlob && <audio controls src={URL.createObjectURL(audioBlob)} />}
      </section>

      {status && <p className="success">{status}</p>}
      {error && <p className="error">{error}</p>}

      <div className="action-row">
        <button className="secondary" type="button" onClick={() => setStepIndex((current) => Math.max(current - 1, 0))}>
          Back
        </button>
        <button type="button" onClick={saveAndNext} disabled={loadingAction !== '' || (!audioBlob && !currentQuestionSaved)}>
          <Save size={18} />
          {loadingAction === 'save' ? 'Saving...' : 'Save and Next'}
        </button>
        <button className="primary" type="button" onClick={generateReport} disabled={loadingAction !== '' || !hasAllResponses}>
          <Sparkles size={18} />
          {loadingAction === 'generate' ? 'Generating...' : 'Generate Report'}
        </button>
      </div>
    </main>
  );
}
