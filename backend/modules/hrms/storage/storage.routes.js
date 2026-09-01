/**
 * HRMS file access routes, mounted at /api/v1/hrms/files.
 *
 * The parent router has already applied protect -> attachHrmsActor ->
 * requireHrmsAccess, so everything here is authenticated and holds at least
 * some HRMS grant. Per-object authorisation happens in storage.service.js.
 */

import express from 'express';

import { issueReadUrl, FileAccessError } from './storage.service.js';
import { getStorageDriver, getObjectStream } from '../../../utils/hrms/storage/index.js';
import { STORAGE_CATEGORY_LIST } from '../../../shared/constants/hrms.js';

const router = express.Router();

/**
 * GET /api/v1/hrms/files/url?category=...&key=...
 *
 * Returns a short-lived presigned URL. The bytes then travel browser <-> S3
 * directly; they never pass through this process (AD-7).
 */
router.get('/url', async (req, res, next) => {
  try {
    const { category, key } = req.query;

    if (!category || !key) {
      return res
        .status(400)
        .json({ success: false, message: 'Both "category" and "key" are required.' });
    }
    if (!STORAGE_CATEGORY_LIST.includes(String(category))) {
      return res.status(400).json({ success: false, message: 'Unknown file category.' });
    }

    const { url, expiresInSeconds } = await issueReadUrl({
      category: String(category),
      key: String(key),
      actor: req.hrmsActor,
      req,
    });

    res.status(200).json({ success: true, data: { url, expiresInSeconds } });
  } catch (error) {
    if (error instanceof FileAccessError) {
      return res.status(error.statusCode).json({ success: false, message: error.message });
    }
    next(error);
  }
});

/**
 * GET /api/v1/hrms/files/local
 *
 * Serves an object from local disk against a signed, expiring token. Exists
 * only so the development driver presents the SAME access pattern as S3 - the
 * caller receives a short-lived URL either way, so the flow being tested
 * locally is the flow that runs in production.
 *
 * Refuses outright unless the local driver is active.
 */
router.get('/local', async (req, res, next) => {
  try {
    const driver = getStorageDriver();
    if (driver.name !== 'local') {
      return res.status(404).json({ success: false, message: 'Not found.' });
    }

    const { key, expires, sig } = req.query;
    if (!driver.verifySignedUrl({ key, expires, sig })) {
      return res.status(403).json({ success: false, message: 'Invalid or expired file link.' });
    }

    const stream = await getObjectStream(String(key));
    stream.on('error', () =>
      res.headersSent ? res.end() : res.status(404).json({ success: false, message: 'Not found.' }),
    );
    stream.pipe(res);
  } catch (error) {
    next(error);
  }
});

export default router;
