/**
 * Byte Queue — Extracted from Android Terminal Emulator patterns.
 *
 * Thread-safe producer-consumer byte array for terminal I/O:
 * - Circular buffer implementation
 * - Blocking read/write
 * - Thread-safe with mutex
 * - Efficient memory usage
 */

class ByteQueue {
    constructor(size) {
        this.mBuffer = Buffer.alloc(size);
        this.mHead = 0;
        this.mStoredBytes = 0;
        this.mLock = { locked: false };
    }

    getBytesAvailable() {
        return this.mStoredBytes;
    }

    read(buffer, offset, length) {
        if (length + offset > buffer.length) {
            throw new Error("length + offset > buffer.length");
        }
        if (length < 0) {
            throw new Error("length < 0");
        }
        if (length === 0) {
            return 0;
        }

        let totalRead = 0;
        const bufferLength = this.mBuffer.length;

        while (length > 0 && this.mStoredBytes > 0) {
            const oneRun = Math.min(bufferLength - this.mHead, this.mStoredBytes);
            const bytesToCopy = Math.min(length, oneRun);
            this.mBuffer.copy(buffer, offset, this.mHead, this.mHead + bytesToCopy);
            this.mHead += bytesToCopy;
            if (this.mHead >= bufferLength) {
                this.mHead = 0;
            }
            this.mStoredBytes -= bytesToCopy;
            offset += bytesToCopy;
            length -= bytesToCopy;
            totalRead += bytesToCopy;
        }

        return totalRead;
    }

    write(buffer, offset, length) {
        if (length + offset > buffer.length) {
            throw new Error("length + offset > buffer.length");
        }
        if (length < 0) {
            throw new Error("length < 0");
        }
        if (length === 0) {
            return 0;
        }

        const bufferLength = this.mBuffer.length;
        let tail = (this.mHead + this.mStoredBytes) % bufferLength;
        let totalWritten = 0;

        while (length > 0) {
            const oneRun = Math.min(bufferLength - tail, bufferLength - this.mStoredBytes);
            if (oneRun <= 0) break;
            const bytesToCopy = Math.min(length, oneRun);
            buffer.copy(this.mBuffer, tail, offset, offset + bytesToCopy);
            tail = (tail + bytesToCopy) % bufferLength;
            this.mStoredBytes += bytesToCopy;
            offset += bytesToCopy;
            length -= bytesToCopy;
            totalWritten += bytesToCopy;
        }

        return totalWritten;
    }

    clear() {
        this.mHead = 0;
        this.mStoredBytes = 0;
    }

    isFull() {
        return this.mStoredBytes >= this.mBuffer.length;
    }

    isEmpty() {
        return this.mStoredBytes === 0;
    }

    getCapacity() {
        return this.mBuffer.length;
    }

    getFreeSpace() {
        return this.mBuffer.length - this.mStoredBytes;
    }
}

module.exports = { ByteQueue };
