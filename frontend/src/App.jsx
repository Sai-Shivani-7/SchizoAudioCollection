import { useState } from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { LogOut, ShieldCheck, UserRound } from 'lucide-react';
import AdminDashboard from './pages/AdminDashboard';
import AuthPage from './pages/AuthPage';
import ReportView from './pages/ReportView';
import UserDashboard from './pages/UserDashboard';
import './styles.css';

export default function App() {
  const [currentUser, setCurrentUser] = useState(() => {
    const stored = localStorage.getItem('sdc-auth-user');
    return stored ? JSON.parse(stored) : null;
  });

  function logout() {
    localStorage.removeItem('sdc-auth-token');
    localStorage.removeItem('sdc-auth-user');
    localStorage.removeItem('sdc-submission-id');
    setCurrentUser(null);
  }

  if (!currentUser) return <AuthPage onAuth={setCurrentUser} />;

  const isAdmin = currentUser.role === 'admin';

  return (
    <div className="app-shell">
      <nav className="top-nav">
        <div className="brand">
          <span>SDCS</span>
          <strong>Schizophrenia Data Collection System</strong>
        </div>
        <div className="nav-links">
          {isAdmin ? (
            <NavLink to="/admin">
              <ShieldCheck size={18} />
              Admin Dashboard
            </NavLink>
          ) : (
            <NavLink to="/">
              <UserRound size={18} />
              Dashboard
            </NavLink>
          )}
          <button className="secondary nav-user" type="button" onClick={logout}>
            <LogOut size={18} />
            {currentUser.name}
          </button>
        </div>
      </nav>

      <Routes>
        {isAdmin ? (
          <>
            <Route path="/admin" element={<AdminDashboard />} />
            <Route path="/report/:id" element={<ReportView />} />
            <Route path="*" element={<Navigate to="/admin" replace />} />
          </>
        ) : (
          <>
            <Route path="/" element={<UserDashboard currentUser={currentUser} />} />
            <Route path="/report/:id" element={<ReportView />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </>
        )}
      </Routes>
    </div>
  );
}
