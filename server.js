const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// In-memory store for active share sessions
// Structure: { shareId: { senderPeerId: '...', hostSocketId: '...' } }
const activeShares = {};

// Serve static files from the current directory (for index.html, script.js, worker.js)
// __dirname will resolve to the directory where server.js is located.
app.use(express.static(__dirname));

io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    socket.on('create-id', (senderPeerId) => {
        if (!senderPeerId) {
            console.error('Error: senderPeerId is undefined for create-id event from socket:', socket.id);
            // Optionally, emit an error back to the client
            // socket.emit('error-message', 'senderPeerId was not provided.');
            return;
        }
        const shareId = uuidv4().slice(0, 6); // Generate a short, unique ID
        activeShares[shareId] = { senderPeerId, hostSocketId: socket.id };
        socket.join(shareId); // Sender joins a room associated with the shareId
        socket.emit('id-created', shareId);
        console.log(`Share ID ${shareId} created for sender ${senderPeerId} (socket ${socket.id})`);
    });

    socket.on('join-id', (shareId) => {
        const shareSession = activeShares[shareId];
        if (shareSession) {
            socket.join(shareId); // Receiver joins the room
            socket.emit('sender-peer-id', shareSession.senderPeerId);
            console.log(`Receiver ${socket.id} joined share ID ${shareId}, sender peer ID ${shareSession.senderPeerId} sent.`);
        } else {
            socket.emit('id-not-found', shareId);
            console.log(`Share ID ${shareId} not found for receiver ${socket.id}`);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Check if the disconnected user was a sender hosting a share
        for (const shareId in activeShares) {
            if (activeShares[shareId].hostSocketId === socket.id) {
                console.log(`Sender ${socket.id} (share ID ${shareId}) disconnected. Removing share.`);
                delete activeShares[shareId];
                // Notify all clients in the room that the share has ended
                io.to(shareId).emit('share-ended', shareId);
                console.log(`Notified clients in room ${shareId} that the share has ended.`);
                break;
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
