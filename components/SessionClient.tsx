'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { io, Socket } from 'socket.io-client';
import { useRouter } from 'next/navigation';
import GrandTreeScene, { DEFAULT_PHOTOS, SceneState } from './GrandTreeScene';

type User = {
  id: string;
  name: string;
};

type SceneSnapshot = {
  sceneState: SceneState;
  rotationSpeed: number;
  photos?: string[];
};

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
};

export default function SessionClient({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  const socketRef = useRef<Socket | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [userName, setUserName] = useState<string>('');
  const [users, setUsers] = useState<User[]>([]);
  const [controllerId, setControllerId] = useState<string | null>(null);
  const [pendingRequests, setPendingRequests] = useState<Record<string, string>>({});
  const [sceneState, setSceneState] = useState<SceneState>('FORMED');
  const [rotationSpeed, setRotationSpeed] = useState(0);
  const [photos, setPhotos] = useState<string[]>(DEFAULT_PHOTOS);
  const [aiStatus, setAiStatus] = useState('INITIALIZING...');
  const [debugMode, setDebugMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(true);
  const [streamStatus, setStreamStatus] = useState('Waiting for controller stream...');

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const viewerPeerRef = useRef<RTCPeerConnection | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sceneUpdateTimeoutRef = useRef<number | null>(null);
  const isControllerRef = useRef(false);
  const pendingViewersRef = useRef<Set<string>>(new Set());

  const isController = useMemo(() => userId && controllerId === userId, [userId, controllerId]);

  useEffect(() => {
    isControllerRef.current = Boolean(isController);
  }, [isController]);

  useEffect(() => {
    const storageKey = `session-name-${sessionId}`;
    let storedName = sessionStorage.getItem(storageKey);
    if (!storedName) {
      storedName = window.prompt('Enter your name to join this session') || '';
    }
    if (!storedName) {
      router.push('/');
      return;
    }
    sessionStorage.setItem(storageKey, storedName);
    setUserName(storedName);
  }, [router, sessionId]);

  useEffect(() => {
    if (!userName) return;

    const socket = io();
    socketRef.current = socket;

    socket.emit('session:join', { sessionId, name: userName });

    socket.on('session:joined', ({ userId, users, controllerId, sceneState }: { userId: string; users: User[]; controllerId: string; sceneState: SceneSnapshot | null }) => {
      setUserId(userId);
      setUsers(users);
      setControllerId(controllerId);
      if (sceneState) {
        setSceneState(sceneState.sceneState);
        setRotationSpeed(sceneState.rotationSpeed);
        if (sceneState.photos) setPhotos(sceneState.photos);
      }
    });

    socket.on('session:user-joined', ({ user }: { user: User }) => {
      setUsers((prev) => [...prev, user]);
    });

    socket.on('session:user-left', ({ userId }: { userId: string }) => {
      setUsers((prev) => prev.filter((user) => user.id !== userId));
      setPendingRequests((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
    });

    socket.on('control:requested', ({ requesterId, requesterName }: { requesterId: string; requesterName: string }) => {
      setPendingRequests((prev) => ({ ...prev, [requesterId]: requesterName }));
    });

    socket.on('control:offer', ({ fromId, fromName }: { fromId: string; fromName: string }) => {
      const accepted = window.confirm(`${fromName} wants to pass control to you. Accept?`);
      if (accepted) {
        socket.emit('control:accept', { sessionId });
      } else {
        socket.emit('control:decline', { sessionId, fromId });
      }
    });

    socket.on('control:declined', ({ targetName }: { targetName: string }) => {
      window.alert(`${targetName} declined the control request.`);
    });

    socket.on('control:changed', ({ controllerId }: { controllerId: string }) => {
      setControllerId(controllerId);
      setPendingRequests({});
    });

    socket.on('scene:state', ({ sceneState }: { sceneState: SceneSnapshot }) => {
      if (isControllerRef.current) return;
      if (sceneState.sceneState) setSceneState(sceneState.sceneState);
      if (sceneState.rotationSpeed !== undefined) setRotationSpeed(sceneState.rotationSpeed);
      if (sceneState.photos) setPhotos(sceneState.photos);
    });

    socket.on('photos:update', ({ photos }: { photos: string[] }) => {
      if (isControllerRef.current) return;
      setPhotos(photos);
    });

    socket.on('scene:sync', ({ sceneState }: { sceneState: SceneSnapshot | null }) => {
      if (!sceneState) return;
      setSceneState(sceneState.sceneState);
      setRotationSpeed(sceneState.rotationSpeed);
      if (sceneState.photos) setPhotos(sceneState.photos);
    });

    socket.on('webrtc:viewer-join', async ({ viewerId }: { viewerId: string }) => {
      if (!isControllerRef.current) return;
      const stream = ensureLocalStream();
      if (!stream) {
        pendingViewersRef.current.add(viewerId);
        return;
      }
      await sendOfferToViewer(viewerId, socket, stream);
    });

    socket.on('webrtc:offer', async ({ from, offer }: { from: string; offer: RTCSessionDescriptionInit }) => {
      if (isControllerRef.current) return;
      const pc = createViewerPeerConnection(from, socket);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('webrtc:answer', { to: from, answer });
    });

    socket.on('webrtc:answer', async ({ from, answer }: { from: string; answer: RTCSessionDescriptionInit }) => {
      if (!isControllerRef.current) return;
      const pc = peerConnectionsRef.current.get(from);
      if (!pc) return;
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    socket.on('webrtc:ice', async ({ from, candidate }: { from: string; candidate: RTCIceCandidateInit }) => {
      const targetPc = isControllerRef.current
        ? peerConnectionsRef.current.get(from)
        : viewerPeerRef.current;
      if (!targetPc) return;
      try {
        await targetPc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn('Failed to add ICE candidate', err);
      }
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [userName, sessionId, router]);

  useEffect(() => {
    if (!socketRef.current || !controllerId || !userId) return;
    if (!isController) {
      socketRef.current.emit('webrtc:viewer-join', { sessionId });
      setStreamStatus('Connecting to controller stream...');
    } else {
      setStreamStatus('You are streaming to everyone.');
    }
  }, [controllerId, isController, sessionId, userId]);

  useEffect(() => {
    if (!isController) {
      stopLocalStream();
      return;
    }
    ensureLocalStream();
  }, [isController]);

  useEffect(() => {
    if (!isController || !socketRef.current) return;
    if (sceneUpdateTimeoutRef.current) {
      window.clearTimeout(sceneUpdateTimeoutRef.current);
    }
    sceneUpdateTimeoutRef.current = window.setTimeout(() => {
      socketRef.current?.emit('scene:update', {
        sessionId,
        sceneState: {
          sceneState,
          rotationSpeed
        }
      });
    }, 150);

    return () => {
      if (sceneUpdateTimeoutRef.current) {
        window.clearTimeout(sceneUpdateTimeoutRef.current);
      }
    };
  }, [sceneState, rotationSpeed, isController, sessionId]);

  useEffect(() => {
    if (isController) {
      closeViewerPeer();
      stopRemoteVideo();
      return;
    }
    closeControllerPeers();
  }, [isController]);

  const ensureLocalStream = () => {
    if (!canvasRef.current) return null;
    if (localStreamRef.current) return localStreamRef.current;
    localStreamRef.current = canvasRef.current.captureStream(30);
    flushPendingViewers(localStreamRef.current);
    return localStreamRef.current;
  };

  const stopLocalStream = () => {
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    closeControllerPeers();
  };

  const closeControllerPeers = () => {
    peerConnectionsRef.current.forEach((pc) => pc.close());
    peerConnectionsRef.current.clear();
    pendingViewersRef.current.clear();
  };

  const closeViewerPeer = () => {
    if (viewerPeerRef.current) {
      viewerPeerRef.current.close();
      viewerPeerRef.current = null;
    }
  };

  const stopRemoteVideo = () => {
    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.srcObject = null;
    }
  };

  const createControllerPeerConnection = (viewerId: string, socket: Socket, stream: MediaStream) => {
    if (peerConnectionsRef.current.has(viewerId)) {
      peerConnectionsRef.current.get(viewerId)?.close();
    }
    const pc = new RTCPeerConnection(RTC_CONFIG);
    stream.getTracks().forEach((track) => pc.addTrack(track, stream));
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc:ice', { to: viewerId, candidate: event.candidate });
      }
    };
    peerConnectionsRef.current.set(viewerId, pc);
    return pc;
  };

  const createViewerPeerConnection = (controllerId: string, socket: Socket) => {
    closeViewerPeer();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('webrtc:ice', { to: controllerId, candidate: event.candidate });
      }
    };
    pc.ontrack = (event) => {
      if (videoRef.current) {
        videoRef.current.srcObject = event.streams[0];
        videoRef.current.play().catch(() => undefined);
        setStreamStatus('Live stream connected.');
      }
    };
    viewerPeerRef.current = pc;
    return pc;
  };

  const sendOfferToViewer = async (viewerId: string, socket: Socket, stream: MediaStream) => {
    const pc = createControllerPeerConnection(viewerId, socket, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    socket.emit('webrtc:offer', { to: viewerId, offer });
  };

  const flushPendingViewers = (stream: MediaStream) => {
    if (!socketRef.current) return;
    const pending = Array.from(pendingViewersRef.current.values());
    pendingViewersRef.current.clear();
    pending.forEach((viewerId) => {
      sendOfferToViewer(viewerId, socketRef.current as Socket, stream).catch(() => undefined);
    });
  };

  const handleGesture = useCallback((newState: SceneState) => {
    if (!isController) return;
    setSceneState((prev) => {
      if (newState === 'PHOTO' && prev !== 'CAROUSEL') return prev;
      if (prev === 'PHOTO' && newState !== 'CAROUSEL') return prev;
      return newState;
    });
  }, [isController]);

  const handleMove = useCallback((speed: number) => {
    if (!isController) return;
    setRotationSpeed(speed);
  }, [isController]);

  const handleUploadFiles = useCallback(async (files: FileList) => {
    if (!isController) return;
    setAiStatus('COMPRESSING IMAGES...');
    try {
      const fileArray = Array.from(files).filter(file => file.type.startsWith('image/'));
      const compressedPhotos = await Promise.all(
        fileArray.map((file) => compressImage(file))
      );
      if (compressedPhotos.length > 0) {
        setPhotos(compressedPhotos);
        socketRef.current?.emit('photos:update', { sessionId, photos: compressedPhotos });
        setAiStatus('UPLOAD COMPLETE');
      }
    } catch (err) {
      console.error('Compression failed:', err);
      setAiStatus('ERROR: COMPRESSION FAILED');
    }
  }, [isController]);

  const handleRequestControl = () => {
    if (!socketRef.current) return;
    socketRef.current.emit('control:request', { sessionId });
  };

  const handleOfferControl = (targetId: string) => {
    if (!socketRef.current || !isController) return;
    socketRef.current.emit('control:offer', { sessionId, targetId });
  };

  const handleCopyLink = async () => {
    const link = `${window.location.origin}/session/${sessionId}`;
    try {
      await navigator.clipboard.writeText(link);
      window.alert('Session link copied to clipboard.');
    } catch {
      window.prompt('Copy this session link:', link);
    }
  };

  return (
    <div style={{ width: '100vw', height: '100vh', position: 'relative' }}>
      {isController ? (
        <GrandTreeScene
          sceneState={sceneState}
          rotationSpeed={sceneState === 'PHOTO' ? 0 : rotationSpeed}
          photos={photos}
          debugMode={debugMode}
          aiStatus={aiStatus}
          onGesture={handleGesture}
          onMove={handleMove}
          onStatus={setAiStatus}
          onUploadFiles={handleUploadFiles}
          onToggleDebug={() => setDebugMode((prev) => !prev)}
          onCanvasReady={(canvas) => {
            canvasRef.current = canvas;
            if (isControllerRef.current) {
              ensureLocalStream();
            }
          }}
          enableControls={isController}
          showUi={isController}
        />
      ) : (
        <div style={{ width: '100%', height: '100%', background: '#000', position: 'relative' }}>
          <video
            ref={videoRef}
            style={{ width: '100%', height: '100%', objectFit: 'cover', position: 'absolute', top: 0, left: 0 }}
            muted
            playsInline
            autoPlay
          />
          <div style={{ position: 'absolute', top: '20px', left: '50%', transform: 'translateX(-50%)', color: '#ffd700', fontSize: '12px', letterSpacing: '2px', zIndex: 10, background: 'rgba(0,0,0,0.6)', padding: '6px 10px', borderRadius: '6px' }}>
            {streamStatus}
          </div>
        </div>
      )}

      <div style={{ position: 'absolute', top: '20px', right: '20px', zIndex: 20, display: 'flex', gap: '8px' }}>
        <button
          onClick={handleCopyLink}
          style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(255, 215, 0, 0.6)', background: 'rgba(0,0,0,0.6)', color: '#ffd700', fontWeight: 600, cursor: 'pointer' }}
        >
          Share Link
        </button>
        <button
          onClick={() => router.push('/')}
          style={{ padding: '8px 12px', borderRadius: '8px', border: '1px solid rgba(255, 215, 0, 0.3)', background: 'rgba(0,0,0,0.6)', color: '#f5e6b0', fontWeight: 600, cursor: 'pointer' }}
        >
          Leave
        </button>
      </div>

      <div style={{ position: 'absolute', right: '40px', bottom: '100px', zIndex: 30, width: '110px' }}>
        <div style={{ background: 'rgba(0,0,0,0.7)', border: '1px solid #FFD700', padding: '10px', boxShadow: '0 10px 40px rgba(0,0,0,0.6)' }}>
          <button
            onClick={() => setMenuOpen((prev) => !prev)}
            style={{ width: '100%', backgroundColor: 'rgba(0,0,0,0.5)', border: 'none', color: '#FFD700', fontFamily: 'sans-serif', fontSize: '12px', fontWeight: 'bold', cursor: 'pointer', backdropFilter: 'blur(4px)' }}
          >
            {menuOpen ? 'Hide Users' : 'Users'}
          </button>

          {menuOpen ? (
            <div style={{ marginTop: '12px', display: 'flex', flexDirection: 'column', gap: '8px', color: '#f5e6b0' }}>
              <div style={{ fontSize: '11px', textTransform: 'uppercase', letterSpacing: '1px', color: '#FFD700' }}>
                Online ({users.length})
              </div>
              {users.map((user) => {
                const isUserController = user.id === controllerId;
                const isYou = user.id === userId;
                const isRequested = !!pendingRequests[user.id];
                return (
                  <button
                    key={user.id}
                    onClick={() => (isController && !isYou ? handleOfferControl(user.id) : undefined)}
                    style={{
                      textAlign: 'left',
                      padding: '8px 10px',
                      borderRadius: '10px',
                      border: '1px solid rgba(255, 215, 0, 0.25)',
                      background: isUserController ? 'rgba(255, 215, 0, 0.2)' : 'rgba(0,0,0,0.5)',
                      color: '#f5e6b0',
                      cursor: isController && !isYou ? 'pointer' : 'default'
                    }}
                  >
                    {user.name}{isYou ? ' (You)' : ''} {isUserController ? '• Controller' : ''} {isRequested ? '• Requested' : ''}
                  </button>
                );
              })}

              {!isController ? (
                <button
                  onClick={handleRequestControl}
                  style={{ padding: '8px 10px', borderRadius: '10px', border: '1px solid rgba(255, 215, 0, 0.6)', background: 'transparent', color: '#ffd700', fontWeight: 600, cursor: 'pointer' }}
                >
                  Request Control
                </button>
              ) : (
                <div style={{ fontSize: '11px', color: 'rgba(255, 215, 0, 0.6)' }}>
                  Click a user to offer control.
                </div>
              )}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const compressImage = (file: File, maxWidth = 384, quality = 0.9): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (event) => {
      const img = new Image();
      img.src = event.target?.result as string;
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Could not get canvas context'));

        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.onerror = (error) => reject(error);
    };
    reader.onerror = (error) => reject(error);
  });
};
