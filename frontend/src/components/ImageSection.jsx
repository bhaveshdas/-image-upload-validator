import { formatTimestamp, humanFileSize } from '@upload-platform/shared';

function StatusPill({ status }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}

export function ImageSection({ title, items, emptyLabel, onRetry, onDelete }) {
  return (
    <section className="panel list-panel">
      <div className="panel-head">
        <div>
          <h2>{title}</h2>
          <p>{emptyLabel}</p>
        </div>
      </div>
      <div className="image-list">
        {items.length === 0 ? (
          <div className="empty-state">{emptyLabel}</div>
        ) : items.map((item) => (
          <article key={item.id} className="image-row">
            <div className="image-preview">
              {item.mediaUrls?.preview ? <img src={item.mediaUrls.preview} alt={item.fileName} /> : <span>{item.fileName.slice(0, 1).toUpperCase()}</span>}
            </div>
            <div className="image-content">
              <div className="image-title-line">
                <h3>{item.fileName}</h3>
                <StatusPill status={item.status} />
              </div>
              <div className="image-meta">
                <span>{humanFileSize(item.sizeBytes)}</span>
                <span>{formatTimestamp(item.createdAt)}</span>
                {item.width && item.height ? <span>{item.width} × {item.height}</span> : null}
              </div>
              {item.rejectionReasons?.length ? (
                <ul className="reason-list">
                  {item.rejectionReasons.map((reason) => (
                    <li key={reason.code}>{reason.message}</li>
                  ))}
                </ul>
              ) : item.validationResults?.[0]?.details?.blurScore ? (
                <div className="validation-summary">
                  Blur score {Math.round(item.validationResults[0].details.blurScore)}. Face coverage {Math.round((item.validationResults[0].details.face?.coverageRatio || 0) * 100)}%.
                </div>
              ) : null}
            </div>
            <div className="row-actions">
              {item.status !== 'deleted' ? (
                <>
                  <button type="button" className="secondary-button" onClick={() => onRetry(item.id)}>Retry</button>
                  <button type="button" className="ghost-button" onClick={() => onDelete(item.id)}>Delete</button>
                </>
              ) : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
