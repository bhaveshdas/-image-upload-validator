import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isAcceptedImage } from '@upload-platform/shared';
import { createUploadTicket, deleteImage, fetchImages, retryImage, uploadToSignedUrl } from './api.js';
import { Dropzone } from './components/Dropzone.jsx';
import { ImageSection } from './components/ImageSection.jsx';

function StatusCard({ label, value }) {
  return (
    <div className="stat-card">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export default function App() {
  const queryClient = useQueryClient();
  const [draftFiles, setDraftFiles] = useState([]);
  const [banner, setBanner] = useState(null);
  const [lastEvent, setLastEvent] = useState('Connecting live status stream');
  const eventSourceRef = useRef(null);

  const imagesQuery = useQuery({
    queryKey: ['images'],
    queryFn: fetchImages,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return undefined;
    }
    const source = new EventSource('/api/events');
    eventSourceRef.current = source;
    source.addEventListener('ready', () => setLastEvent('Live status stream active'));
    source.addEventListener('image.updated', () => queryClient.invalidateQueries({ queryKey: ['images'] }));
    source.onerror = () => setLastEvent('Live stream reconnecting');
    return () => source.close();
  }, [queryClient]);

  const uploadMutation = useMutation({
    mutationFn: async (files) => {
      for (const file of files) {
        if (!isAcceptedImage(file.name, file.type || 'application/octet-stream')) {
          throw new Error(`${file.name} is not a supported image type.`);
        }
        const ticket = await createUploadTicket(file);
        await uploadToSignedUrl(ticket.uploadUrl, file);
      }
    },
    onSuccess: async () => {
      setBanner({ kind: 'success', text: 'Upload complete. Validation is running in the background.' });
      setDraftFiles([]);
      await queryClient.invalidateQueries({ queryKey: ['images'] });
    },
    onError: (error) => {
      setBanner({ kind: 'error', text: error instanceof Error ? error.message : 'Upload failed.' });
    },
  });

  const retryMutation = useMutation({
    mutationFn: retryImage,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['images'] }),
  });

  const deleteMutation = useMutation({
    mutationFn: deleteImage,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['images'] }),
  });

  const images = imagesQuery.data?.images || [];
  const accepted = useMemo(() => images.filter((image) => image.status === 'accepted'), [images]);
  const rejected = useMemo(() => images.filter((image) => image.status === 'rejected'), [images]);
  const active = useMemo(() => images.filter((image) => ['uploading', 'uploaded', 'queued', 'processing'].includes(image.status)), [images]);

  return (
    <div className="app-shell">
      <aside className="rail">
        <div className="brand-mark">
          <span className="brand-dot" />
          <div>
            <strong>Image Intake</strong>
            <span>validation platform</span>
          </div>
        </div>
        <div className="rail-copy">
          <h1>Direct uploads, automatic review, live acceptance.</h1>
          <p>
            Files go straight to storage through signed upload URLs, then a worker checks dimensions, blur, duplicate similarity, HEIC conversion, and face size before
            the result appears in the accepted or rejected queue.
          </p>
        </div>
        <div className="rail-status">
          <div className="pulse" />
          <span>{lastEvent}</span>
        </div>
      </aside>

      <main className="workspace">
        {banner ? <div className={`banner banner-${banner.kind}`}>{banner.text}</div> : null}

        <section className="stats-grid">
          <StatusCard label="Accepted" value={accepted.length} />
          <StatusCard label="Rejected" value={rejected.length} />
          <StatusCard label="In flight" value={active.length} />
        </section>

        <Dropzone
          files={draftFiles}
          uploading={uploadMutation.isPending}
          error={uploadMutation.error?.message}
          onFilesSelected={(files) => {
            setBanner(null);
            setDraftFiles(files);
            uploadMutation.mutate(files);
          }}
        />

        <div className="sections-grid">
          <ImageSection
            title="Accepted"
            items={accepted}
            emptyLabel="No images have passed validation yet."
            onRetry={(id) => retryMutation.mutate(id)}
            onDelete={(id) => deleteMutation.mutate(id)}
          />
          <ImageSection
            title="Rejected"
            items={rejected}
            emptyLabel="Rejected images will show their reasons here."
            onRetry={(id) => retryMutation.mutate(id)}
            onDelete={(id) => deleteMutation.mutate(id)}
          />
        </div>

        <section className="panel activity-panel">
          <div className="panel-head">
            <div>
              <h2>All uploads</h2>
              <p>Newest items first, with live status from the backend worker.</p>
            </div>
          </div>
          <div className="activity-list">
            {images.length === 0 ? <div className="empty-state">Upload a file to see it move through the pipeline.</div> : images.map((item) => (
              <article key={item.id} className="activity-row">
                <div>
                  <strong>{item.fileName}</strong>
                  <span>{item.status}</span>
                </div>
                <span>{item.sizeLabel}</span>
              </article>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
