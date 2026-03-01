import React, { useState } from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'

function AuthWrapper() {
  const [isAuthenticated, setIsAuthenticated] = useState(
    localStorage.getItem('sector_app_auth') === 'true'
  );
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');

  const handleLogin = (e) => {
    e.preventDefault();
    const correctPassword = import.meta.env.VITE_APP_PASSWORD || 'sector2026';
    if (password === correctPassword) {
      localStorage.setItem('sector_app_auth', 'true');
      setIsAuthenticated(true);
    } else {
      setError('Incorrect password');
    }
  };

  if (isAuthenticated) {
    return <App />;
  }

  const S = {
    page: { minHeight: "100vh", background: "#07090e", color: "#b8c4d4", fontFamily: "'IBM Plex Mono','SF Mono',monospace", display: "grid", placeItems: "center" },
    card: { background: "#0b0f18", border: "1px solid #161d2b", borderRadius: 12, padding: 32, width: "100%", maxWidth: 360 },
    input: { width: "100%", padding: "12px", background: "#070910", border: "1px solid #1c2536", borderRadius: 6, color: "#dde4ed", fontSize: 13, fontFamily: "inherit", outline: "none", boxSizing: "border-box", marginBottom: 16 },
    btn: { width: "100%", padding: "12px", background: "linear-gradient(135deg,#2563eb,#7c3aed)", border: "none", borderRadius: 8, color: "#fff", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
  };

  return (
    <div style={S.page}>
      <form onSubmit={handleLogin} style={S.card}>
        <div style={{ textAlign: "center", marginBottom: 24, fontSize: 18, fontWeight: 700, color: "#e8ecf2", letterSpacing: -0.5 }}>Sector Classifier<br /><span style={{ fontSize: 12, color: "#4a5974", fontWeight: 400 }}>Protected Access</span></div>
        {error && <div style={{ color: "#fca5a5", fontSize: 12, marginBottom: 12, textAlign: "center", background: "#dc262610", border: "1px solid #dc262625", padding: "8px", borderRadius: 6 }}>{error}</div>}
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Enter Password"
          style={S.input}
          autoFocus
        />
        <button type="submit" style={S.btn}>Access App</button>
      </form>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthWrapper />
  </React.StrictMode>,
)
