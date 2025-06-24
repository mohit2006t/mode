document.addEventListener('DOMContentLoaded', () => {
    const appContainer = document.getElementById('app-container');

    // UI States
    const senderUploadState = document.getElementById('sender-upload-state');
    const senderSharingState = document.getElementById('sender-sharing-state');
    const receiverOfferState = document.getElementById('receiver-offer-state');
    const receiverDownloadingState = document.getElementById('receiver-downloading-state');
    const receiverCompleteState = document.getElementById('receiver-complete-state');

    // Sender Upload State Elements
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const fileInfoUpload = document.getElementById('file-info-upload');
    const shareButton = document.getElementById('share-button');

    // Sender Sharing State Elements
    const fileInfoSharing = document.getElementById('file-info-sharing');
    const shareLinkInput = document.getElementById('share-link-input');
    const copyLinkButton = document.getElementById('copy-link-button');

    // Receiver Offer State Elements
    const fileInfoOffer = document.getElementById('file-info-offer');
    const downloadButton = document.getElementById('download-button');

    // Receiver Downloading State Elements
    const fileInfoDownloading = document.getElementById('file-info-downloading');
    const progressPercentage = document.getElementById('progress-percentage');
    const downloadProgressBar = document.getElementById('download-progress-bar');
    const downloadProgressFill = document.getElementById('download-progress-fill');
    const transferSpeedEl = document.getElementById('transfer-speed');

    // Receiver Complete State Elements
    const fileInfoComplete = document.getElementById('file-info-complete');
    const saveFileLink = document.getElementById('save-file-link');

    let selectedFile = null;
    let peer = null;
    let hostPeerId = null; // Sender's peer ID
    let remotePeerId = null; // Receiver's connected sender peer ID (if receiver)
    let peer = null; // Can be sender or receiver peer object
    let socket = null;
    let currentShareId = null; // For sender, the ID they are hosting. For receiver, the ID they joined.
    let isSharingActive = false; // For sender

    // Sender specific: Manages multiple receiver connections
    const senderConnections = new Map(); // Key: peerId of receiver, Value: PeerJS DataConnection object

    // Receiver specific
    let fileToDownloadInfo = null; // {name, size, fileType, totalChunks}
    let fileWorker = null;
    let peerConnectionToSender = null; // Receiver's DataConnection to the sender

    const CHUNK_SIZE = 256 * 1024; // 256 KB

    // --- Utility Functions ---
    function formatFileSize(bytes) {
        if (bytes === 0) return '0 Bytes';
        const k = 1024;
        const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    }

    function switchUiState(newStateElement) {
        [senderUploadState, senderSharingState, receiverOfferState, receiverDownloadingState, receiverCompleteState].forEach(el => {
            if (el) { // Check if element exists
                el.classList.add('hidden', 'opacity-0');
            }
        });
        if (newStateElement) {
            newStateElement.classList.remove('hidden');
            // Trigger reflow before changing opacity for transition
            void newStateElement.offsetWidth;
            newStateElement.classList.remove('opacity-0');
        }
    }

    // --- Sender Logic ---
    function initializeSenderPeer() {
        peer = new Peer();
        peer.on('open', (id) => {
            hostPeerId = id;
            console.log('Sender PeerJS ID:', hostPeerId);
            // Now that peer is ready, connect to Socket.IO
            connectSocketAndShare();
        });

        peer.on('connection', (conn) => { // This is for the SENDER
            console.log(`SENDER: Incoming connection from receiver ${conn.peer}`);
            senderConnections.set(conn.peer, conn);
            console.log(`SENDER: Connection from ${conn.peer} stored. Total connections: ${senderConnections.size}`);

            conn.on('open', () => {
                console.log(`SENDER: Data connection opened with ${conn.peer}`);
                if (selectedFile) {
                    const totalChunks = Math.ceil(selectedFile.size / CHUNK_SIZE);
                    const metadata = {
                        type: 'file-info',
                        name: selectedFile.name,
                        size: selectedFile.size,
                        fileType: selectedFile.type || 'application/octet-stream',
                        totalChunks: totalChunks
                    };
                    conn.send(metadata);
                    console.log(`SENDER: Sent file-info to ${conn.peer}:`, metadata);
                } else {
                    console.warn(`SENDER: Connection from ${conn.peer} but no file selected/active.`);
                    conn.send({type: 'error', message: 'No file is currently being shared.'});
                    conn.close(); // Or handle more gracefully
                }
            });

            conn.on('data', (data) => {
                // SENDER handles messages from a specific receiver (conn)
                console.log(`SENDER: Received data from ${conn.peer}:`, data);
                if (data.type === 'start-transfer' && selectedFile) {
                    console.log(`SENDER: Received start-transfer from ${conn.peer}. Starting file send.`);
                    sendFileInChunks(conn, selectedFile);
                } else if (data.type === 'ack-chunk') {
                    // Optional: Handle acknowledgements for flow control / reliability
                    console.log(`SENDER: Received ack for chunk ${data.sequence} from ${conn.peer}`);
                }
            });

            conn.on('close', () => {
                console.log(`SENDER: Connection with ${conn.peer} closed.`);
                senderConnections.delete(conn.peer);
                console.log(`SENDER: Removed connection ${conn.peer}. Total connections: ${senderConnections.size}`);
            });

            conn.on('error', (err) => {
                console.error(`SENDER: Error on connection with ${conn.peer}:`, err);
                senderConnections.delete(conn.peer);
            });
        });

        peer.on('error', (err) => {
            console.error('PeerJS error:', err);
            let message = 'An unexpected error occurred with the P2P connection. Please refresh and try again.';
            if (err.type === 'unavailable-id') {
                message = 'The requested ID is already taken. Please try a different one or refresh.';
            } else if (err.type === 'peer-unavailable') {
                message = 'The other user is no longer available. The share may have ended.';
                if (currentShareId) { // If receiver was trying to connect
                    resetReceiverUiOnError(`File share ID ${currentShareId} is not available.`);
                }
            }
            alert(message);
            // More specific UI reset might be needed depending on context
        });
    }

    // Sender: Connects to Socket.IO after PeerJS is open, to get a shareId
    function connectSocketAndShare() {
        if (!hostPeerId) {
            console.error("PeerJS not ready yet.");
            alert("Sharing service not ready, please wait a moment and try again.");
            resetSenderUiToUpload();
            return;
        }

        socket = io();

        socket.on('connect', () => {
            console.log('Connected to Socket.IO server.');
            socket.emit('create-id', hostPeerId);
        });

        socket.on('id-created', (shareId) => {
            currentShareId = shareId;
            const shareLink = `${window.location.origin}/?id=${shareId}`;
            shareLinkInput.value = shareLink;
            fileInfoSharing.innerHTML = `<strong>${selectedFile.name}</strong> (${formatFileSize(selectedFile.size)})`;
            switchUiState(senderSharingState);
            isSharingActive = true;
            window.addEventListener('beforeunload', beforeUnloadHandler);
            console.log('Share link created:', shareLink);
        });

        socket.on('disconnect', () => {
            console.log('Disconnected from Socket.IO server.');
            // alert('Connection to server lost. Sharing may be interrupted.');
            // No automatic UI reset here, as PeerJS connections might persist for a bit
        });

        socket.on('share-ended', (endedShareId) => {
            if (currentShareId === endedShareId) {
                alert('The share has been ended because the host disconnected.');
                // This event is more relevant for receivers, but good to log for sender too
                console.log(`Share ${endedShareId} was ended by the server.`);
            }
        });
    }

    function handleFileSelect(file) {
        if (file) {
            selectedFile = file;
            fileInfoUpload.textContent = `${selectedFile.name} (${formatFileSize(selectedFile.size)})`;
            shareButton.disabled = false;
            shareButton.classList.remove('opacity-50', 'cursor-not-allowed');
            shareButton.classList.add('hover:bg-brand-white', 'hover:text-brand-black');
        } else {
            resetSenderUiToUpload();
        }
    }

    function resetSenderUiToUpload() {
        selectedFile = null;
        fileInput.value = ''; // Reset file input
        fileInfoUpload.textContent = '';
        shareButton.disabled = true;
        shareButton.classList.add('opacity-50', 'cursor-not-allowed');
        shareButton.classList.remove('hover:bg-brand-white', 'hover:text-brand-black');
        if (isSharingActive) {
            window.removeEventListener('beforeunload', beforeUnloadHandler);
            isSharingActive = false;
        }
        currentShareId = null; // Reset current share ID
        // Close all active sender connections
        senderConnections.forEach(conn => {
            conn.close();
        });
        senderConnections.clear();

        if (socket) {
            socket.disconnect();
            socket = null;
        }
        if (peer) {
            // We don't destroy the peer object itself immediately,
            // as it might be needed if user quickly tries to share another file.
            // However, existing connections would be implicitly closed by socket disconnect & share end.
        }
        switchUiState(senderUploadState);
    }

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('bg-zinc-100');
    });
    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('bg-zinc-100');
    });
    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('bg-zinc-100');
        if (e.dataTransfer.files.length) {
            handleFileSelect(e.dataTransfer.files[0]);
        }
    });
    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length) {
            handleFileSelect(e.target.files[0]);
        }
    });

    shareButton.addEventListener('click', () => {
        if (selectedFile) {
            // Disable button to prevent multiple clicks
            shareButton.disabled = true;
            shareButton.classList.add('opacity-50', 'cursor-not-allowed');
            shareButton.textContent = 'Generating Link...';

            if (!peer || peer.destroyed) { // Initialize PeerJS if it's the first time or it was destroyed
                initializeSenderPeer();
            } else if (!peer.open) { // If peer exists but is not open (e.g. reconnecting)
                console.log("Peer exists but not open, waiting for 'open' event...");
                peer.on('open', () => { // Re-attach listener just in case
                    hostPeerId = peer.id;
                    connectSocketAndShare();
                });
            } else { // Peer is already initialized and open
                hostPeerId = peer.id;
                connectSocketAndShare();
            }
        }
    });

    let copyTimeout = null;
    copyLinkButton.addEventListener('click', () => {
        shareLinkInput.select();
        document.execCommand('copy');
        copyLinkButton.textContent = 'Copied!';
        copyLinkButton.disabled = true;

        if (copyTimeout) clearTimeout(copyTimeout);
        copyTimeout = setTimeout(() => {
            copyLinkButton.textContent = 'Copy';
            copyLinkButton.disabled = false;
        }, 2000);
    });

    function beforeUnloadHandler(event) {
        if (isSharingActive) {
            event.preventDefault();
            event.returnValue = 'Closing this tab will stop sharing the file. Are you sure?';
        }
    }

    async function sendFileInChunks(conn, file) {
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        console.log(`SENDER: Preparing to send ${file.name} in ${totalChunks} chunks to ${conn.peer}.`);

        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);

            try {
                const arrayBuffer = await chunk.arrayBuffer();
                // Check if connection is still open before sending
                if (conn && conn.open) {
                    conn.send({
                        type: 'chunk',
                        payload: arrayBuffer,
                        sequence: i,
                        totalChunks: totalChunks,
                        fileName: file.name // For worker, though file-info should be primary source
                    });
                    console.log(`SENDER: Sent chunk ${i + 1}/${totalChunks} to ${conn.peer} (${arrayBuffer.byteLength} bytes)`);
                    // Optional: wait for ack for flow control: await waitForAck(conn, i);
                } else {
                    console.warn(`SENDER: Connection to ${conn.peer} closed or not available. Stopping chunk sending.`);
                    return; // Stop sending if connection is lost
                }
            } catch (error) {
                console.error(`SENDER: Error reading or sending chunk ${i} to ${conn.peer}:`, error);
                // Potentially close connection or retry
                conn.close(); // Example: close on error
                senderConnections.delete(conn.peer);
                return;
            }
        }

        if (conn && conn.open) {
            conn.send({ type: 'transfer-complete', fileName: file.name });
            console.log(`SENDER: Sent transfer-complete to ${conn.peer} for ${file.name}`);
        }
    }


    // --- Receiver Logic ---
    function initializeReceiverPeer(targetShareId) {
        currentShareId = targetShareId; // Store the ID from URL
        peer = new Peer(); // Receiver gets its own PeerJS ID automatically

        peer.on('open', (id) => {
            console.log('Receiver PeerJS ID:', id);
            // Now PeerJS is ready, connect to Socket.IO to get sender's PeerJS ID
            connectSocketForReceiver(targetShareId);
        });

        // 'connection' event for receiver is handled when it actively connects to sender
        // Error handling is covered by the generic peer.on('error')
    }

    function connectSocketForReceiver(shareIdToJoin) {
        socket = io();

        socket.on('connect', () => {
            console.log('Receiver connected to Socket.IO server.');
            socket.emit('join-id', shareIdToJoin);
        });

        socket.on('sender-peer-id', (senderPeerId) => {
            remotePeerId = senderPeerId; // Store sender's PeerJS ID
            console.log('RECEIVER: Received sender PeerJS ID:', remotePeerId);
            connectToSenderPeer();
        });

        socket.on('id-not-found', (requestedId) => {
            console.error('Share ID not found:', requestedId);
            resetReceiverUiOnError(`File share ID "${requestedId}" was not found or has expired.`);
        });

        socket.on('share-ended', (endedShareId) => {
            if (currentShareId === endedShareId) {
                console.log(`Share ${endedShareId} was ended by the host.`);
                resetReceiverUiOnError('The file share has been ended by the host.');
                // Could also try to close any active P2P connection here
                if (peer && remotePeerId) {
                    // Potentially close connection to remotePeerId if one exists
                }
            }
        });

        socket.on('disconnect', () => {
            console.log('Receiver disconnected from Socket.IO server.');
            // If not yet connected to peer, this might mean the share is gone or server issue.
            // If already downloading, P2P might continue for a bit.
        });
    }

    downloadButton.addEventListener('click', () => {
        if (!remotePeerId) {
            alert('Sender information not available yet. Please wait.');
            return;
        }
        if (!peer || peer.destroyed) {
            alert('P2P connection is not initialized. Please refresh.');
            return;
        }
        console.log('RECEIVER: Download button clicked.');
        if (!peerConnectionToSender || !peerConnectionToSender.open) {
            alert('Not connected to sender yet. Please wait for file info.');
            return;
        }
        if (!fileToDownloadInfo) {
            alert('File information not yet received. Please wait.');
            return;
        }

        // Initialize worker and send file info BEFORE sending 'start-transfer'
        if (!fileWorker) {
            fileWorker = new Worker('worker.js');
            setupFileWorkerListeners();
            // fileToDownloadInfo should be populated as 'file-info' must be received to enable this button
            if (fileToDownloadInfo) {
                fileWorker.postMessage({ type: 'info', ...fileToDownloadInfo });
            } else {
                // This case should ideally not be reached if button enablement logic is correct
                console.error("RECEIVER: Download clicked but fileToDownloadInfo is missing.");
                resetReceiverUiOnError("File information is missing. Cannot start download.");
                return;
            }
        }

        console.log('RECEIVER: Sending start-transfer to sender.');
        peerConnectionToSender.send({ type: 'start-transfer' });

        // Transition to downloading UI
        fileInfoDownloading.innerHTML = `Downloading <strong>${fileToDownloadInfo.name}</strong> (${formatFileSize(fileToDownloadInfo.size)})`;
        progressPercentage.textContent = '0%';
        downloadProgressFill.style.width = '0%';
        transferSpeedEl.textContent = 'Speed: 0 MB/s';
        switchUiState(receiverDownloadingState);
        downloadButton.disabled = true; // Disable while download is in progress
    });

    function connectToSenderPeer() {
        if (!peer || peer.destroyed) {
            console.error("RECEIVER: PeerJS not initialized for receiver.");
            resetReceiverUiOnError("P2P connection service not available. Please refresh.");
            return;
        }
        if (!remotePeerId) {
            console.error("RECEIVER: Sender Peer ID not known.");
            resetReceiverUiOnError("Could not find sender information. The share link might be invalid or expired.");
            return;
        }

        console.log(`RECEIVER: Attempting to connect to sender peer: ${remotePeerId}`);
        fileInfoOffer.innerHTML = `Connecting to peer for file information...`;
        switchUiState(receiverOfferState); // Show offer state while connecting

        peerConnectionToSender = peer.connect(remotePeerId, { reliable: true });

        peerConnectionToSender.on('open', () => {
            console.log(`RECEIVER: Connection to sender ${remotePeerId} opened.`);
            // Now wait for file-info from sender.
            // The 'data' event handler will take over.
            fileInfoOffer.innerHTML = `Waiting for file information from sender...`;
            // Download button should be disabled until file-info is received.
            downloadButton.disabled = true;
        });

        peerConnectionToSender.on('data', (data) => {
            // RECEIVER handles messages from the SENDER
            console.log('RECEIVER: Data received from sender:', data.type);

            if (data.type === 'file-info') {
                fileToDownloadInfo = {
                    name: data.name,
                    size: data.size,
                    fileType: data.fileType,
                    totalChunks: data.totalChunks // Crucial for worker
                };
                console.log('RECEIVER: Received file-info:', fileToDownloadInfo);
                fileInfoOffer.innerHTML = `Ready to download: <strong>${fileToDownloadInfo.name}</strong> (${formatFileSize(fileToDownloadInfo.size)})`;
                downloadButton.disabled = false; // Enable download button now
                // UI is already receiverOfferState, waiting for user to click download.
            } else if (data.type === 'chunk') {
                // fileWorker should already be initialized by the time chunks arrive,
                // because 'start-transfer' (which triggers chunk sending) is only sent
                // after user clicks "Download", and worker is initialized on that click.
                if (!fileWorker) {
                    console.error("RECEIVER: Received chunk but worker not initialized. This shouldn't happen.");
                    // Attempt to initialize as a fallback, though data.totalChunks might be from this chunk
                    // and not the original fileToDownloadInfo if it was missed.
                    fileWorker = new Worker('worker.js');
                    setupFileWorkerListeners();
                    // Try to send info, assuming fileToDownloadInfo is populated
                    if(fileToDownloadInfo) fileWorker.postMessage({ type: 'info', ...fileToDownloadInfo });
                    else { //This is a more critical error, sender started sending chunks before file-info was fully processed or download was clicked
                        resetReceiverUiOnError("Critical: File data received prematurely. Download cannot proceed.");
                        return;
                    }
                }
                // Forward chunk to worker
                fileWorker.postMessage({
                    type: 'chunk',
                    payload: data.payload,
                    sequence: data.sequence,
                    totalChunks: data.totalChunks // Send totalChunks with each chunk
                }, [data.payload]); // Transfer ArrayBuffer
            } else if (data.type === 'transfer-complete') {
                console.log('RECEIVER: Received transfer-complete signal from sender.');
                if (fileWorker) {
                    fileWorker.postMessage({ type: 'transfer-complete' });
                }
            } else if (data.type === 'error') {
                console.error('RECEIVER: Received error from sender:', data.message);
                resetReceiverUiOnError(`Error from sender: ${data.message}`);
                if (fileWorker) fileWorker.postMessage({ type: 'cancel-download' });
            }
        });

        peerConnectionToSender.on('close', () => {
            console.log('RECEIVER: Connection to sender closed.');
            // If downloading, worker should already be handling completion or error.
            // If not yet completed, this indicates an issue.
            if (receiverDownloadingState.classList.contains('hidden') && receiverCompleteState.classList.contains('hidden')) {
                // Only show error if not already completed or in the process of completing normally
                // resetReceiverUiOnError('Connection to sender lost prematurely.');
            }
            if (fileWorker) {
                // Ensure worker knows transfer might be incomplete if it didn't get 'transfer-complete'
                // This is tricky because 'close' can happen after successful transfer.
                // Rely on worker's own completion logic or explicit 'transfer-complete' message.
            }
        });

        peerConnectionToSender.on('error', (err) => {
            console.error('RECEIVER: Error in connection to sender:', err);
            resetReceiverUiOnError(`Connection error: ${err.message || 'Failed to connect to sender.'}`);
            if (fileWorker) fileWorker.postMessage({ type: 'cancel-download' });
        });
    }

    function setupFileWorkerListeners() {
        if (!fileWorker) return;

        fileWorker.onmessage = (e) => {
            const { type, ...data } = e.data;
            // console.log('RECEIVER: Message from worker:', type, data);

            if (type === 'progress') {
                progressPercentage.textContent = `${data.percentage}%`;
                downloadProgressFill.style.width = `${data.percentage}%`;
                transferSpeedEl.textContent = `Speed: ${data.speed}`;
                fileInfoDownloading.innerHTML = `Downloading <strong>${fileToDownloadInfo.name}</strong> (${formatFileSize(fileToDownloadInfo.size)})`;

            } else if (type === 'complete') {
                console.log('RECEIVER: Worker reported file assembly complete.');
                const blobUrl = URL.createObjectURL(data.payload);
                saveFileLink.href = blobUrl;
                saveFileLink.download = data.fileName;

                fileInfoComplete.innerHTML = `<strong>${data.fileName}</strong> (${formatFileSize(data.payload.size)}) downloaded.`;
                switchUiState(receiverCompleteState);

                if (peerConnectionToSender) peerConnectionToSender.close();
                fileWorker.terminate();
                fileWorker = null;
            } else if (type === 'error') {
                console.error('RECEIVER: Worker reported an error:', data.message);
                resetReceiverUiOnError(`Download failed: ${data.message}`);
                if (peerConnectionToSender) peerConnectionToSender.close();
            } else if (type === 'cancelled') {
                console.log('RECEIVER: Worker confirmed download cancellation.');
                // UI might already be reset by resetReceiverUiOnError
            }
        };

        fileWorker.onerror = (err) => {
            console.error('RECEIVER: Unhandled error in Web Worker:', err);
            resetReceiverUiOnError(`An unexpected error occurred during download processing. ${err.message}`);
            if (peerConnectionToSender) peerConnectionToSender.close();
            if (fileWorker) {
                fileWorker.terminate();
                fileWorker = null;
            }
        };
    }

    function resetReceiverUiOnError(errorMessage) {
        alert(errorMessage);
        appContainer.innerHTML = `<div class="text-center space-y-4">
            <h1 class="text-2xl font-bold text-red-500">Error</h1>
            <p class="text-brand-black">${errorMessage}</p>
            <a href="/" class="text-blue-500 hover:underline">Go to homepage</a>
        </div>`;
        if (socket) socket.disconnect();
        if (peerConnectionToSender) peerConnectionToSender.close();
        if (peer) peer.destroy();
        if (fileWorker) {
            fileWorker.postMessage({ type: 'cancel-download' }); // Attempt graceful worker shutdown
            // fileWorker.terminate(); // Or force terminate
            fileWorker = null;
        }
    }


    // --- Initial UI State Determination ---
    function initializeApp() {
        const urlParams = new URLSearchParams(window.location.search);
        const shareIdFromUrl = urlParams.get('id');

        if (shareIdFromUrl) {
            // Receiver flow
            console.log('Receiver mode, attempting to join ID:', shareIdFromUrl);
            initializeReceiverPeer(shareIdFromUrl);
        } else {
            // Sender flow
            console.log('Sender mode');
            switchUiState(senderUploadState);
        }
    }

    initializeApp();
});
