import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import {
  LIBRARY_FILE_MAX_BYTES,
  deleteLibraryFile,
  downloadLibraryFile,
  libraryExtension,
  listLibraryFiles,
  uploadLibraryFile,
} from '../controllers/agentLibraryController.js';

/** AI Agent Library (mounted at /api with authMiddleware). */
const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: LIBRARY_FILE_MAX_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => cb(null, libraryExtension(file.originalname) !== null),
});

/** multer errors (too large, ...) as a clear 4xx answer. */
function uploadOne(req: Request, res: Response, next: NextFunction) {
  upload.single('file')(req, res, (err: unknown) => {
    if (!err) return next();
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'The file is larger than 10 MB' });
    }
    return res.status(400).json({ error: 'The file could not be read' });
  });
}

router.get('/agent-library', listLibraryFiles);
router.post('/agent-library', uploadOne, uploadLibraryFile);
router.get('/agent-library/:id/download', downloadLibraryFile);
router.delete('/agent-library/:id', deleteLibraryFile);

export default router;
