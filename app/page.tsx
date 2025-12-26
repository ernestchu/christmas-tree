'use client';

import { useRouter } from 'next/navigation';
import { v4 as uuidv4 } from 'uuid';
import { useState } from 'react';

const containerStyle: React.CSSProperties = {
  width: '100vw',
  height: '100vh',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: 'radial-gradient(circle at top, #0b1d0f 0%, #000000 55%)',
  color: '#f5e6b0'
};

const cardStyle: React.CSSProperties = {
  width: 'min(540px, 90vw)',
  padding: '32px',
  border: '1px solid rgba(255, 215, 0, 0.35)',
  borderRadius: '16px',
  background: 'rgba(0, 0, 0, 0.65)',
  boxShadow: '0 30px 80px rgba(0, 0, 0, 0.6)',
  backdropFilter: 'blur(8px)'
};

export default function HomePage() {
  const router = useRouter();
  const [sessionIdInput, setSessionIdInput] = useState('');

  const handleCreate = () => {
    const name = window.prompt('Enter your name to create a session');
    if (!name) return;
    const sessionId = uuidv4();
    sessionStorage.setItem(`session-name-${sessionId}`, name);
    router.push(`/session/${sessionId}`);
  };

  const handleJoin = () => {
    const sessionId = sessionIdInput.trim();
    if (!sessionId) return;
    router.push(`/session/${sessionId}`);
  };

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h1 style={{ marginTop: 0, fontSize: '28px', letterSpacing: '1px' }}>Christmas Tree Session</h1>
        <p style={{ color: 'rgba(245, 230, 176, 0.7)', lineHeight: 1.6 }}>
          Create a shared tree experience or join with a session link. You will be asked for your name on entry.
        </p>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginTop: '24px' }}>
          <button
            onClick={handleCreate}
            style={{
              padding: '12px 16px',
              borderRadius: '10px',
              border: '1px solid #ffd700',
              background: '#ffd700',
              color: '#000',
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            Create Session
          </button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <input
              value={sessionIdInput}
              onChange={(event) => setSessionIdInput(event.target.value)}
              placeholder="Paste session id"
              style={{
                flex: 1,
                padding: '12px 14px',
                borderRadius: '10px',
                border: '1px solid rgba(255, 215, 0, 0.4)',
                background: 'rgba(0,0,0,0.4)',
                color: '#f5e6b0'
              }}
            />
            <button
              onClick={handleJoin}
              style={{
                padding: '12px 16px',
                borderRadius: '10px',
                border: '1px solid rgba(255, 215, 0, 0.6)',
                background: 'transparent',
                color: '#ffd700',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              Join
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
