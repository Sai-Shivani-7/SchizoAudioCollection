require('dotenv').config();

const express = require('express');
const cors = require('cors');
const connectDatabase = require('./config/db');
const submissionRoutes = require('./routes/submissionRoutes');
const authRoutes = require('./routes/authRoutes');

const app = express();
const port = process.env.PORT || 5000;

app.use(
  cors({
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  })
);
app.use(express.json({ limit: '10mb' }));
app.use('/api/auth', authRoutes);
app.use('/api', submissionRoutes);

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'Schizophrenia Data Collection System API',
    cloudinaryConfigured: Boolean(process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_UPLOAD_PRESET),
    googleConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
  });
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(error.status || 500).json({ message: error.message || 'Server error.' });
});

connectDatabase().then(() => {
  app.listen(port, () => {
    console.log(`Backend running on http://localhost:${port}`);
  });
});
