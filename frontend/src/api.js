export async function fetchImages() {
  const response = await fetch('/api/images');
  if (!response.ok) {
    throw new Error('Failed to load images.');
  }
  return response.json();
}

export async function createUploadTicket(file) {
  const response = await fetch('/api/images', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      fileName: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Unable to prepare upload.');
  }
  return response.json();
}

export async function uploadToSignedUrl(uploadUrl, file) {
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: {
      'content-type': file.type || 'application/octet-stream',
    },
    body: file,
  });
  if (!response.ok && response.status !== 204) {
    throw new Error('Upload failed.');
  }
}

export async function retryImage(imageId) {
  const response = await fetch(`/api/images/${imageId}/retry`, { method: 'POST' });
  if (!response.ok) {
    throw new Error('Retry failed.');
  }
  return response.json();
}

export async function deleteImage(imageId) {
  const response = await fetch(`/api/images/${imageId}`, { method: 'DELETE' });
  if (!response.ok) {
    throw new Error('Delete failed.');
  }
  return response.json();
}
