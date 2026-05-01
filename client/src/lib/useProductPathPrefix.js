import { useParams } from 'react-router-dom';

/** Prefix for routes under /:productSurface (coordination | agency). */
export function useProductPathPrefix() {
  const { productSurface } = useParams();
  return productSurface ? `/${productSurface}` : '';
}
