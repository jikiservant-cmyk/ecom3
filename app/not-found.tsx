import Link from 'next/link';

export default function NotFound() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '2rem' }}>
      <h2 style={{ fontSize: '2rem', marginBottom: '1rem', fontWeight: 'bold' }}>Page Not Found</h2>
      <p style={{ marginBottom: '2rem', color: '#666' }}>Could not find requested resource</p>
      <Link href="/" style={{ padding: '0.75rem 1.5rem', backgroundColor: '#e11d48', color: 'white', borderRadius: '0.5rem', textDecoration: 'none', fontWeight: 'bold' }}>
        Return Home
      </Link>
    </div>
  );
}
