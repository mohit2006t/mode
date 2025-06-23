let receivedBuffer = [];
let receivedSize = 0;
let totalFileSize = 0;
let lastReceivedSize = 0;
let speedInterval = null;

self.onmessage = (event) => {
    const { type, payload } = event.data;

    switch (type) {
        case 'info':
            totalFileSize = payload.fileSize;
            receivedBuffer = [];
            receivedSize = 0;
            lastReceivedSize = 0;
            speedInterval = setInterval(postProgress, 1000);
            break;

        case 'chunk':
            receivedBuffer.push(payload);
            receivedSize += payload.byteLength;

            if (receivedSize >= totalFileSize) {
                clearInterval(speedInterval);
                postProgress();
                const blob = new Blob(receivedBuffer);
                self.postMessage({ type: 'complete', payload: blob });
                receivedBuffer = [];
            }
            break;
    }
};

function postProgress() {
    const percent = totalFileSize > 0 ? (receivedSize / totalFileSize) * 100 : 0;
    const bytesSinceLast = receivedSize - lastReceivedSize;
    lastReceivedSize = receivedSize;

    self.postMessage({ type: 'progress', payload: { percent, bytesSinceLast } });
}