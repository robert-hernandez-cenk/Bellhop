import { useLayoutEffect, useRef, useState } from 'react';

export function PageDescription({ children }: { children: React.ReactNode }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [hasOverflow, setHasOverflow] = useState(false);

  useLayoutEffect(() => {
    if (expanded) return;
    const check = () => {
      const el = ref.current;
      if (!el) return;
      setHasOverflow(el.scrollHeight > el.clientHeight + 1);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [children, expanded]);

  return (
    <>
      <p ref={ref} className={`page-description${expanded ? '' : ' page-description-clamped'}`}>
        {children}
      </p>
      {hasOverflow && (
        <button
          type="button"
          className="page-description-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}
