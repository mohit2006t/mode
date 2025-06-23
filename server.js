const express = require('express');
const socketio = require('socket.io');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

const server = app.listen(PORT);
const io = socketio(server);
const ids = {};

io.on('connection', (socket) => {
    socket.on('create-id', (data) => {
        const { id, peerId } = data;
        if (ids[id]) {
            socket.emit('id-exists', id);
        } else {
            ids[id] = { 
                senderSocketId: socket.id, 
                senderPeerId: peerId, 
                receivers: [] 
            };
            socket.join(id);
            socket.emit('id-created', id);
        }
    });

    socket.on('join-id', (id) => {
        const session = ids[id];
        if (session) {
            session.receivers.push(socket.id);
            socket.join(id);
            socket.emit('sender-info', { peerId: session.senderPeerId });
        } else {
            socket.emit('id-not-found', id);
        }
    });

    socket.on('disconnect', () => {
        for (const id in ids) {
            const session = ids[id];
            if (session.senderSocketId === socket.id) {
                session.receivers.forEach(receiverSocketId => {
                    io.to(receiverSocketId).emit('peer-disconnected', { id, message: 'Sender has disconnected.' });
                });
                delete ids[id];
                break;
            } else {
                const receiverIndex = session.receivers.indexOf(socket.id);
                if (receiverIndex !== -1) {
                    session.receivers.splice(receiverIndex, 1);
                    io.to(session.senderSocketId).emit('receiver-left', { receiverSocketId: socket.id });
                    break;
                }
            }
        }
    });
});
