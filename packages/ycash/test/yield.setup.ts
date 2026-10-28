// Copyright (c) 2026 The Ycash developers
// Distributed under the MIT software license.
//
// A macrotask yield before and after every test. The worker reports results to the main process over
// birpc, which fails a call ("Timeout calling onTaskUpdate") when its answer is not processed within
// 60 s. Tests over in-process fakes await only microtasks, so a run of CPU-heavy tests (SLH-DSA signing
// is ≈ 1–2 s per signature in noble, several times that on a 2-core CI runner) can hold the worker's
// event loop for over a minute: the answer then waits behind the expired timeout timer and the run
// fails with every test passed. Yielding here bounds a blocking stretch by one test.
import { afterEach, beforeEach } from "vitest";

const macrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
beforeEach(macrotask);
afterEach(macrotask);
