// Runs in a worker thread (started by images.js). HEIC decoding is pure WebAssembly and can
// take tens of seconds on a small server; doing it here keeps the main thread (live auction,
// sockets, API) responsive.
import { parentPort, workerData } from 'node:worker_threads';
import convertHeic from 'heic-convert';

const out = await convertHeic({ buffer: Buffer.from(workerData), format: 'JPEG', quality: 0.92 });
parentPort.postMessage(Buffer.from(out));
