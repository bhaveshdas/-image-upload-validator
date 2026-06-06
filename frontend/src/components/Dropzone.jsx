import { useEffect, useState } from 'react';
import { humanFileSize } from '@upload-platform/shared';

export function Dropzone({ files, onFilesSelected, uploading, error }) {
  const [previews, setPreviews] = useState([]);

  useEffect(() => {
    const nextPreviews = files.map((file) => ({
      file,
      url: URL.createObjectURL(file),
    }));
    setPreviews(nextPreviews);
    return () => {
      for (const preview of nextPreviews) {
        URL.revokeObjectURL(preview.url);
      }
    };
  }, [files]);

  return (
    <section className="panel dropzone-panel">
      <div className="panel-head">
        <div>
          <h2>Upload queue</h2>
          <p>Drop up to 20 JPEG, PNG, HEIC, or HEIF files. Each one gets a live validation pass.</p>
        </div>
        <label className={`primary-button${uploading ? ' disabled' : ''}`}>
          <input
            type="file"
            accept=".jpg,.jpeg,.png,.heic,image/jpeg,image/png,image/heic"
            multiple
            onChange={(event) => onFilesSelected([...event.target.files])}
            disabled={uploading}
          />
          Select files
        </label>
      </div>

      <div className="dropzone" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
        event.preventDefault();
        onFilesSelected([...event.dataTransfer.files]);
      }}>
        <div className="dropzone-copy">
          <strong>Drag files here</strong>
          <span>Previews render locally before upload. Validation starts after transfer.</span>
        </div>
        {files.length > 0 ? (
          <div className="preview-strip">
            {previews.map(({ file, url }) => (
              <figure key={`${file.name}-${file.lastModified}`} className="preview-card">
                <img src={url} alt={file.name} />
                <figcaption>
                  <strong>{file.name}</strong>
                  <span>{humanFileSize(file.size)}</span>
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="dropzone-hint">PNG, JPEG, HEIC, and HEIF are allowed. Maximum file size is 12 MB.</div>
        )}
      </div>

      {error ? <div className="inline-error">{error}</div> : null}
    </section>
  );
}
