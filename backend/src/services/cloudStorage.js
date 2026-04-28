function sanitizeFolderSegment(value = 'participant') {
  return String(value)
    .trim()
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .replace(/\s+/g, '_')
    .slice(0, 80) || 'participant';
}

async function uploadToCloudinary({ buffer, fileName, mimeType, folder = 'schizophrenia-data-collection', resourceType }) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME?.trim();
  const uploadPreset = process.env.CLOUDINARY_UPLOAD_PRESET?.trim();

  if (!cloudName || !uploadPreset) {
    const error = new Error('Cloudinary is not configured. Set CLOUDINARY_CLOUD_NAME and CLOUDINARY_UPLOAD_PRESET.');
    error.status = 503;
    throw error;
  }

  const selectedResourceType = resourceType || (mimeType?.includes('zip') || fileName?.toLowerCase().endsWith('.zip') ? 'raw' : 'video');
  const formData = new FormData();
  formData.append('file', new Blob([buffer], { type: mimeType }), fileName);
  formData.append('upload_preset', uploadPreset);
  formData.append('folder', folder);

  const response = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/${selectedResourceType}/upload`, {
    method: 'POST',
    body: formData,
  });

  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error?.message || 'Cloudinary upload failed.');
    error.status = response.status;
    throw error;
  }

  return {
    url: payload.secure_url,
    publicId: payload.public_id,
    bytes: payload.bytes,
    resourceType: payload.resource_type,
  };
}

async function uploadTextAsset({ text, fileName, folder, mimeType = 'text/plain' }) {
  return uploadToCloudinary({
    buffer: Buffer.from(text, 'utf8'),
    fileName,
    mimeType,
    folder,
    resourceType: 'raw',
  });
}

module.exports = { sanitizeFolderSegment, uploadToCloudinary, uploadTextAsset };
