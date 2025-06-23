document.addEventListener('DOMContentLoaded', () => {
    const senderUiDiv = document.getElementById('sender-ui'), receiverUiDiv = document.getElementById('receiver-ui');
    const uploadContainer = document.getElementById('upload-container'), sharingContainer = document.getElementById('sharing-container');
    const uploadArea = document.getElementById('upload-area'), fileInput = document.getElementById('file-input');
    const shareBtn = document.getElementById('share-btn'), fileInfoDiv = document.getElementById('file-info');
    const sharingFileInfoDiv = document.getElementById('sharing-file-info'), linkInput = document.getElementById('link-input');
    const copyBtn = document.getElementById('copy-btn'), copyBtnText = document.getElementById('copy-btn-text'), copyBtnIcon = document.getElementById('copy-btn-icon');
    const receivingFileInfoDiv = document.getElementById('receiving-file-info'), acceptBtn = document.getElementById('accept-btn');
    const transferStatsDiv = document.getElementById('transfer-stats'), downloadAreaDiv = document.getElementById('download-area');
    const downloadLink = document.getElementById('download-link');
    const downloadProgressBar = document.getElementById('download-progress-bar'), downloadProgressFill = document.getElementById('download-progress-fill');
    const errorMessageDiv = document.getElementById('error-message');

    const CHUNK_SIZE = 256 * 1024;
    let selectedFile = null, peer = null, dataConnection = null;
    let selfPeerId = null, currentId = null, receivedFileName = '';
    let isSender = true, receivedSize = 0, totalFileSize = 0;
    let isSharing = false;
    let receivedBuffer = [], speedInterval = null, lastReceivedSize = 0;
    let connections = new Map();

    const socket = io();
    const urlParams = new URLSearchParams(window.location.search);
    const idFromUrl = urlParams.get('id');

    if (idFromUrl) {
        isSender = false;
        currentId = idFromUrl;
        senderUiDiv.classList.add('hidden');
        receiverUiDiv.classList.remove('hidden');
        setTimeout(() => receiverUiDiv.classList.remove('opacity-0'), 10);
    } else {
        setTimeout(() => uploadContainer.classList.remove('opacity-0'), 10);
    }
    initializePeerJS();

    function initializePeerJS() {
        try {
            peer = new Peer();
            peer.on('open', (id) => {
                selfPeerId = id;
                if (isSender) {
                    shareBtn.disabled = false;
                } else if (currentId) {
                    socket.emit('join-id', currentId);
                }
            });
            peer.on('connection', (conn) => {
                if (isSender) {
                    setupSenderConnection(conn);
                }
            });
            peer.on('error', (err) => console.error(`PeerJS error: ${err.message}`));
        } catch (e) { console.error("Failed to initialize PeerJS.", e); }
    }

    function setupSenderConnection(conn) {
        connections.set(conn.peer, conn);
        conn.on('open', () => {
            conn.send({ type: 'file-info', fileName: selectedFile.name, fileSize: selectedFile.size });
        });
        conn.on('data', (data) => {
            if (data.type === 'start-transfer') {
                sendFile();
            }
        });
        conn.on('close', () => {
            connections.delete(conn.peer);
        });
    }

    function setupReceiverConnection(conn) {
        dataConnection = conn;
        dataConnection.on('data', onDataReceived);
        dataConnection.on('close', () => showError("Transfer interrupted."));
    }

    function onDataReceived(data) {
        if (data.type === 'file-info') {
            totalFileSize = data.fileSize; receivedFileName = data.fileName;
            receivingFileInfoDiv.innerHTML = `<p class="font-semibold">${receivedFileName}</p><p class="text-sm text-zinc-600">${formatFileSize(totalFileSize)}</p>`;
            acceptBtn.classList.remove('hidden');
        } else {
            receivedBuffer.push(data);
            receivedSize += data.byteLength;
            if (receivedSize >= totalFileSize) assembleAndDownloadFile();
        }
    }

    socket.on('id-created', id => {
        uploadContainer.classList.add('hidden');
        sharingContainer.classList.remove('hidden');
        setTimeout(() => sharingContainer.classList.remove('opacity-0'), 10);
        sharingFileInfoDiv.innerHTML = `<p class="font-semibold">${selectedFile.name}</p><p class="text-sm text-zinc-600">${formatFileSize(selectedFile.size)}</p>`;
        linkInput.value = `${window.location.origin}/?id=${id}`;
        isSharing = true;
    });

    socket.on('sender-info', (data) => {
        if (!isSender && peer) {
            const conn = peer.connect(data.peerId, { reliable: true });
            setupReceiverConnection(conn);
        }
    });

    socket.on('id-not-found', () => showError("Share ID not found. Check the link."));

    async function sendFile() {
        let offset = 0;
        const sendChunk = async () => {
            if (offset >= selectedFile.size) return;

            const chunk = selectedFile.slice(offset, offset + CHUNK_SIZE);
            try {
                const buffer = await chunk.arrayBuffer();
                for (const conn of connections.values()) {
                    if (conn.open) {
                        conn.send(buffer);
                    }
                }
                offset += buffer.byteLength;
                setTimeout(sendChunk, 10);
            } catch (e) {
                console.error("Error reading chunk:", e);
            }
        };
        sendChunk();
    }

    function assembleAndDownloadFile() {
        updateSpeedAndPercentage();
        clearInterval(speedInterval);
        transferStatsDiv.textContent = 'Transfer complete!';
        const blob = new Blob(receivedBuffer);
        downloadLink.href = URL.createObjectURL(blob);
        downloadLink.download = receivedFileName;
        downloadAreaDiv.classList.remove('hidden');
        receivedBuffer = [];
        receivedSize = 0;
    }

    function updateSpeedAndPercentage() {
        const percent = totalFileSize > 0 ? (receivedSize / totalFileSize) * 100 : 0;
        downloadProgressFill.style.width = `${percent}%`;
        const bytesSinceLast = receivedSize - lastReceivedSize; lastReceivedSize = receivedSize;
        const speed = formatFileSize(bytesSinceLast);
        transferStatsDiv.innerHTML = `<span>${Math.round(percent)}%</span><span class="mx-2 text-zinc-400">|</span><span>${speed}/s</span>`;
    }

    uploadArea.addEventListener('dragover', (e) => { e.preventDefault(); uploadArea.classList.add('border-zinc-700'); });
    uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('border-zinc-700'));
    uploadArea.addEventListener('drop', (e) => { e.preventDefault(); uploadArea.classList.remove('border-zinc-700'); if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]); });
    uploadArea.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => fileInput.files.length && handleFile(fileInput.files[0]));
    shareBtn.addEventListener('click', () => { if (selectedFile && selfPeerId) socket.emit('create-id', { id: generateId(), peerId: selfPeerId }); });
    copyBtn.addEventListener('click', () => {
        linkInput.select();
        navigator.clipboard.writeText(linkInput.value).then(() => {
            copyBtnText.textContent = "Copied!"; copyBtnIcon.classList.remove('hidden');
            setTimeout(() => { copyBtnText.textContent = "Copy"; copyBtnIcon.classList.add('hidden'); }, 2000);
        });
    });
    acceptBtn.addEventListener('click', () => {
        acceptBtn.classList.add('hidden');
        downloadProgressBar.classList.remove('hidden');
        dataConnection.send({ type: 'start-transfer' });
        speedInterval = setInterval(updateSpeedAndPercentage, 1000);
    });

    window.addEventListener('beforeunload', (event) => {
        if (isSharing) {
            event.preventDefault();
            event.returnValue = '';
        }
    });

    function handleFile(file) { selectedFile = file; fileInfoDiv.innerHTML = `<p>${file.name} (${formatFileSize(file.size)})</p>`; }
    function showError(message) { if (errorMessageDiv) errorMessageDiv.textContent = message; }
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024, sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
    }
    function generateId(length = 6) { return Math.random().toString(36).substring(2, 2 + length); }
});
