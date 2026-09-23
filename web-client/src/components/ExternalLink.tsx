import { IconExternalLink } from './icons';

export function ExternalLink({ href, label }: { href: string; label: string }) {
  return (
    <a className="external-link" href={href} target="_blank" rel="noopener noreferrer" aria-label={label}>
      <IconExternalLink size={12} />
    </a>
  );
}
