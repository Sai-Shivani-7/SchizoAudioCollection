import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Eye, RefreshCw, Sparkles } from 'lucide-react';
import { api } from '../api/client';

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [submissions, setSubmissions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [generatingId, setGeneratingId] = useState('');
  const [error, setError] = useState('');

  async function loadSubmissions() {
    setLoading(true);
    setError('');
    try {
      const response = await api.get('/admin/users');
      setSubmissions(response.data);
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to load admin submissions.');
    } finally {
      setLoading(false);
    }
  }

  async function generateReport(submissionId) {
    setGeneratingId(submissionId);
    setError('');
    try {
      await api.post('/generate-report', { submissionId });
      await loadSubmissions();
    } catch (requestError) {
      setError(requestError.response?.data?.message || 'Unable to generate report.');
    } finally {
      setGeneratingId('');
    }
  }

  useEffect(() => {
    loadSubmissions();
  }, []);

  return (
    <main className="page">
      <header className="page-header compact">
        <div>
          <p className="eyebrow">Admin Dashboard</p>
          <h1>Voice Submissions</h1>
          <p>Review saved cloud audio URLs, transcripts, per-question results, and structured reports.</p>
        </div>
        <button className="secondary" type="button" onClick={loadSubmissions}>
          <RefreshCw size={18} />
          Refresh
        </button>
      </header>

      {error && <p className="error">{error}</p>}
      {loading ? (
        <p className="inline-status">Loading submissions...</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Stored Responses</th>
                <th>Status</th>
                <th>Report</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {submissions.map((submission) => {
                const responseCount = Object.keys(submission.responses || {}).length;
                return (
                  <tr key={submission._id}>
                    <td>
                      <strong>{submission.user?.name || submission.userId}</strong>
                      <span>{submission.user?.contact || submission.sessionId}</span>
                    </td>
                    <td>{responseCount} / 3 audios, {responseCount * 2} transcripts, {responseCount} results</td>
                    <td>{submission.status}</td>
                    <td>{submission.report ? `${submission.report.riskLevel} (${submission.report.confidenceScore}%)` : 'Pending'}</td>
                    <td>
                      <div className="table-actions">
                        <button className="secondary" type="button" onClick={() => navigate(`/report/${submission._id}`)}>
                          <Eye size={16} />
                          View Report
                        </button>
                        <button type="button" onClick={() => generateReport(submission._id)} disabled={generatingId === submission._id}>
                          <Sparkles size={16} />
                          {generatingId === submission._id ? 'Generating...' : 'Generate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {submissions.length === 0 && <p className="inline-status">No voice responses have been saved yet.</p>}
        </div>
      )}
    </main>
  );
}
