const express = require('express');
const uploadMemory = require('../middleware/upload');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const {
  saveProgress,
  saveVoiceResponse,
  submitData,
  uploadZip,
  generateReport,
  getReport,
  getAdminUsers,
  getMySubmissions,
} = require('../controllers/submissionController');

const router = express.Router();

router.post('/save-progress', requireAuth, saveProgress);
router.post('/submit-data', requireAuth, submitData);
router.post('/generate-report', requireAuth, generateReport);
router.post('/upload-voice-response', requireAuth, uploadMemory.single('audio'), saveVoiceResponse);
router.post('/upload-zip', requireAuth, uploadMemory.single('zipFile'), uploadZip);
router.get('/get-report/:id', requireAuth, getReport);
router.get('/my-submissions', requireAuth, getMySubmissions);
router.get('/admin/users', requireAuth, requireAdmin, getAdminUsers);

module.exports = router;
