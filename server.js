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
            ids[id] = { senderSocketId: socket.id, senderPeerId: peerId, receiverSocketId: null };
            socket.join(id);
            socket.emit('id-created', id);
        }
    });

    socket.on('join-id', (id) => {
        const session = ids[id];
        if (session && !session.receiverSocketId) {
            session.receiverSocketId = socket.id;
            socket.join(id);
            socket.emit('sender-info', { peerId: session.senderPeerId, id: id });
            io.to(session.senderSocketId).emit('receiver-joined', { receiverSocketId: socket.id, id: id });
        } else if (session) {
            socket.emit('id-full', id);
        } else {
            socket.emit('id-not-found', id);
        }
    });

    socket.on('disconnect', () => {
        for (const id in ids) {
            const session = ids[id];
            if (session.senderSocketId === socket.id) {
                if (session.receiverSocketId) {
                    io.to(session.receiverSocketId).emit('peer-disconnected', { id, message: 'Sender has disconnected.' });
                }
                delete ids[id];
                break;
            } else if (session.receiverSocketId === socket.id) {
                io.to(session.senderSocketId).emit('peer-disconnected', { id, message: 'Receiver has disconnected.' });
                session.receiverSocketId = null;
                break;
            }
        }
    });
});