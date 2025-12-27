import { createServer } from 'http';
import { Server } from 'socket.io';
import next from 'next';

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();

const sessions = new Map();

const getSession = (sessionId) => {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, {
      users: new Map(),
      controllerId: null,
      sceneState: null,
      createdAt: Date.now()
    });
  }
  return sessions.get(sessionId);
};

const getUsersPayload = (session) => {
  return Array.from(session.users.values()).map((user) => ({
    id: user.id,
    name: user.name
  }));
};

app.prepare().then(() => {
  const server = createServer((req, res) => handle(req, res));
  const io = new Server(server, {
    maxHttpBufferSize: 1e8,
    cors: {
      origin: '*'
    }
  });

  io.on('connection', (socket) => {
    socket.on('session:join', ({ sessionId, name }) => {
      const session = getSession(sessionId);
      session.users.set(socket.id, { id: socket.id, name });
      socket.join(sessionId);

      if (!session.controllerId) {
        session.controllerId = socket.id;
      }

      socket.emit('session:joined', {
        sessionId,
        userId: socket.id,
        users: getUsersPayload(session),
        controllerId: session.controllerId,
        sceneState: session.sceneState
      });

      socket.to(sessionId).emit('session:user-joined', {
        user: { id: socket.id, name }
      });
    });

    socket.on('scene:update', ({ sessionId, sceneState }) => {
      const session = sessions.get(sessionId);
      if (!session || session.controllerId !== socket.id) return;
      session.sceneState = { ...(session.sceneState || {}), ...sceneState };
      socket.to(sessionId).emit('scene:state', { sceneState });
    });

    socket.on('photos:update', ({ sessionId, photos }) => {
      const session = sessions.get(sessionId);
      if (!session || session.controllerId !== socket.id) return;
      session.sceneState = { ...(session.sceneState || {}), photos };
      socket.to(sessionId).emit('photos:update', { photos });
    });

    socket.on('control:request', ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session || !session.controllerId) return;
      io.to(session.controllerId).emit('control:requested', {
        requesterId: socket.id,
        requesterName: session.users.get(socket.id)?.name || 'Guest'
      });
    });

    socket.on('control:offer', ({ sessionId, targetId }) => {
      const session = sessions.get(sessionId);
      if (!session || session.controllerId !== socket.id) return;
      io.to(targetId).emit('control:offer', {
        fromId: socket.id,
        fromName: session.users.get(socket.id)?.name || 'Host'
      });
    });

    socket.on('control:accept', ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      session.controllerId = socket.id;
      io.to(sessionId).emit('control:changed', {
        controllerId: socket.id
      });
      socket.emit('scene:sync', {
        sceneState: session.sceneState
      });
    });

    socket.on('control:decline', ({ sessionId, fromId }) => {
      const session = sessions.get(sessionId);
      if (!session) return;
      io.to(fromId).emit('control:declined', {
        targetId: socket.id,
        targetName: session.users.get(socket.id)?.name || 'Guest'
      });
    });

    socket.on('webrtc:viewer-join', ({ sessionId }) => {
      const session = sessions.get(sessionId);
      if (!session || !session.controllerId) return;
      io.to(session.controllerId).emit('webrtc:viewer-join', {
        viewerId: socket.id
      });
    });

    socket.on('webrtc:offer', ({ to, offer }) => {
      io.to(to).emit('webrtc:offer', { from: socket.id, offer });
    });

    socket.on('webrtc:answer', ({ to, answer }) => {
      io.to(to).emit('webrtc:answer', { from: socket.id, answer });
    });

    socket.on('webrtc:ice', ({ to, candidate }) => {
      io.to(to).emit('webrtc:ice', { from: socket.id, candidate });
    });

    socket.on('disconnect', () => {
      for (const [sessionId, session] of sessions.entries()) {
        if (!session.users.has(socket.id)) continue;
        const wasController = session.controllerId === socket.id;
        session.users.delete(socket.id);
        socket.to(sessionId).emit('session:user-left', { userId: socket.id });

        if (wasController) {
          const nextController = session.users.values().next().value?.id || null;
          session.controllerId = nextController;
          if (nextController) {
            io.to(sessionId).emit('control:changed', { controllerId: nextController });
            io.to(nextController).emit('scene:sync', { sceneState: session.sceneState });
          }
        }

        if (session.users.size === 0) {
          sessions.delete(sessionId);
        }
      }
    });
  });

  const port = process.env.PORT || 3000;
  server.listen(port, () => {
    console.log(`Server ready on http://localhost:${port}`);
  });
});
