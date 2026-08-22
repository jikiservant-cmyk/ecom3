'use client';

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  return (
    <html lang="en">
      <body>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '2rem' }}>
          <h2 style={{ fontSize: '2rem', marginBottom: '1rem', fontWeight: 'bold' }}>Something went wrong!</h2>
          <button 
            onClick={() => reset()}
            style={{ padding: '0.75rem 1.5rem', backgroundColor: '#e11d48', color: 'white', borderRadius: '0.5rem', border: 'none', cursor: 'pointer', fontWeight: 'bold' }}
          >
            Try again
          </button>
        </div>
      </body>
    </html>
  );
}
