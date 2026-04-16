import { useEffect, useState } from 'react';

const BREAKPOINT = 768;

export default function useIsMobile() {
  const [mobile, setMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= BREAKPOINT,
  );

  useEffect(() => {
    const handler = () => setMobile(window.innerWidth <= BREAKPOINT);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);

  return mobile;
}
