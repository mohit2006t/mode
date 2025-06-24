// worker.js

let fileChunks = [];
let expectedChunks = 0; // Total number of chunks expected
let receivedChunksCount = 0; // Number of chunks received so far
let fileSize = 0;
let fileName = '';
let fileType = '';
let bytesReceived = 0;
let startTime = null;
let progressInterval = null;

const PROGRESS_INTERVAL_MS = 500; // Post progress every 500ms

function formatSpeed(bytesPerSecond) {
    if (bytesPerSecond === 0) return '0 B/s';
    const k = 1024;
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(k));
    return parseFloat((bytesPerSecond / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function postProgress() {
    if (fileSize === 0) return;

    const percentage = (bytesReceived / fileSize) * 100;
    const elapsedTimeSeconds = startTime ? (Date.now() - startTime) / 1000 : 0;
    const speed = elapsedTimeSeconds > 0 ? bytesReceived / elapsedTimeSeconds : 0;

    self.postMessage({
        type: 'progress',
        percentage: percentage.toFixed(2),
        speed: formatSpeed(speed),
        bytesReceived: bytesReceived
    });
}

function checkCompletion() {
    // Check if all expected chunks have been received
    if (expectedChunks > 0 && receivedChunksCount === expectedChunks) {
        if (progressInterval) clearInterval(progressInterval);

        // Ensure all array slots are filled if using sparse array
        const allChunksPresent = fileChunks.length === expectedChunks && fileChunks.every(chunk => chunk instanceof ArrayBuffer);

        if (allChunksPresent) {
            const fileBlob = new Blob(fileChunks, { type: fileType });
            self.postMessage({
                type: 'complete',
                payload: fileBlob,
                fileName: fileName,
                fileType: fileType
            });
            fileChunks = []; // Clear memory
            self.close(); // Terminate worker
        } else {
            // This case should ideally not happen if sequence numbers are managed correctly
            // and all chunks arrive.
            console.error('Worker: Mismatch in expected and received chunks for completion.');
            self.postMessage({ type: 'error', message: 'File assembly failed due to missing chunks.' });
        }
    }
}


self.onmessage = (e) => {
    const { type, ...data } = e.data;

    switch (type) {
        case 'info':
            fileName = data.name;
            fileSize = data.size;
            fileType = data.fileType;
            // expectedChunks will be set by the first chunk message or a dedicated message if preferred.
            // Reset state for potential new file (though one worker instance per download is typical)
            fileChunks = [];
            bytesReceived = 0;
            receivedChunksCount = 0;
            startTime = Date.now();

            // Initialize fileChunks array if totalChunks is known, otherwise it grows dynamically
            if (data.totalChunks) {
                expectedChunks = data.totalChunks;
                fileChunks = new Array(expectedChunks); // Pre-allocate if total is known
            }

            console.log(`Worker: File info received - Name: ${fileName}, Size: ${fileSize}, Type: ${fileType}, Total Chunks (if known): ${expectedChunks}`);

            if (progressInterval) clearInterval(progressInterval);
            progressInterval = setInterval(postProgress, PROGRESS_INTERVAL_MS);
            break;

        case 'chunk':
            const { payload, sequence, totalChunks } = data;

            if (!expectedChunks && totalChunks) { // Set expectedChunks if received with the first chunk
                expectedChunks = totalChunks;
                fileChunks = new Array(expectedChunks); // Pre-allocate array
            }

            if (sequence >= 0 && sequence < expectedChunks) {
                if (!fileChunks[sequence]) { // Avoid double processing if chunks are resent
                    fileChunks[sequence] = payload;
                    bytesReceived += payload.byteLength;
                    receivedChunksCount++;
                }
            } else {
                console.warn(`Worker: Received chunk with out-of-bounds sequence: ${sequence}. Expected range 0-${expectedChunks-1}`);
                // Optionally, request resend or handle error
            }

            // Post progress immediately after a chunk or rely on interval
            // postProgress(); // For more frequent updates, but interval is usually fine

            checkCompletion(); // Check if this chunk completes the file
            break;

        case 'transfer-complete':
            // This message from sender confirms all chunks are sent.
            // The worker should primarily rely on `expectedChunks` and `receivedChunksCount`.
            console.log("Worker: Received 'transfer-complete' signal from main script.");
            // If expectedChunks was not known, this signal is crucial.
            // However, our design sends totalChunks with each chunk or with file-info.
            // So, checkCompletion should handle it.
            // If, for some reason, checkCompletion hasn't fired (e.g. last chunk didn't trigger it immediately)
            // this is a good place for a final check.
            if (expectedChunks > 0 && receivedChunksCount === expectedChunks) {
                 if (!fileChunks.every(chunk => chunk instanceof ArrayBuffer)) {
                    console.error("Worker: Transfer complete signal received, but not all chunks are present in order.");
                    // This indicates a problem, perhaps some chunks were missed or sequence numbers were off.
                 } else {
                    // This will re-run the completion logic if it hasn't already closed the worker.
                    // It's a safeguard.
                    checkCompletion();
                 }
            } else if (expectedChunks === 0 && fileSize > 0) {
                // This case implies totalChunks was never communicated.
                // This is a fallback, but ideally totalChunks is always known.
                console.warn("Worker: Transfer complete signal received, but total number of chunks was unknown. Assembling with received chunks.");
                const validChunks = fileChunks.filter(c => c instanceof ArrayBuffer);
                const fileBlob = new Blob(validChunks, { type: fileType });
                 self.postMessage({
                    type: 'complete',
                    payload: fileBlob,
                    fileName: fileName,
                    fileType: fileType
                });
                if (progressInterval) clearInterval(progressInterval);
                fileChunks = [];
                self.close();
            }
            break;

        case 'cancel-download':
            console.log("Worker: Download cancellation received.");
            if (progressInterval) clearInterval(progressInterval);
            fileChunks = []; // Release memory
            self.postMessage({ type: 'cancelled' });
            self.close(); // Terminate worker
            break;

        default:
            console.warn('Worker: Unknown message type received', data);
    }
};

console.log('Web Worker (worker.js) initialized.');
