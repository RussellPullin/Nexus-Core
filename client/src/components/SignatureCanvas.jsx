import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';

/**
 * Draw-a-signature canvas, shared between the logged-in user's saved-signature editor
 * (SettingsPage) and the public /sign/:token signer page.
 *
 * Exposes { getDataUrl(), clear() } via ref instead of raw canvas access.
 */
const SignatureCanvas = forwardRef(function SignatureCanvas({ width, height, style }, ref) {
  const canvasRef = useRef(null);
  const isDrawingRef = useRef(false);

  useImperativeHandle(ref, () => ({
    getDataUrl() {
      const canvas = canvasRef.current;
      if (!canvas) return null;
      const ctx = canvas.getContext('2d');
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const hasContent = imageData.data.some((v, i) => i % 4 === 3 && v > 0);
      return hasContent ? canvas.toDataURL('image/png') : null;
    },
    clear() {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }));

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';

    const getPos = (e) => {
      const rect = canvas.getBoundingClientRect();
      const scaleX = canvas.width / rect.width;
      const scaleY = canvas.height / rect.height;
      const clientX = e.touches ? e.touches[0].clientX : e.clientX;
      const clientY = e.touches ? e.touches[0].clientY : e.clientY;
      return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
    };

    const start = (e) => {
      e.preventDefault();
      isDrawingRef.current = true;
      const pos = getPos(e);
      ctx.beginPath();
      ctx.moveTo(pos.x, pos.y);
    };
    const move = (e) => {
      e.preventDefault();
      if (!isDrawingRef.current) return;
      const pos = getPos(e);
      ctx.lineTo(pos.x, pos.y);
      ctx.stroke();
    };
    const end = () => { isDrawingRef.current = false; };

    canvas.addEventListener('mousedown', start);
    canvas.addEventListener('mousemove', move);
    canvas.addEventListener('mouseup', end);
    canvas.addEventListener('mouseleave', end);
    canvas.addEventListener('touchstart', start, { passive: false });
    canvas.addEventListener('touchmove', move, { passive: false });
    canvas.addEventListener('touchend', end);
    return () => {
      canvas.removeEventListener('mousedown', start);
      canvas.removeEventListener('mousemove', move);
      canvas.removeEventListener('mouseup', end);
      canvas.removeEventListener('mouseleave', end);
      canvas.removeEventListener('touchstart', start);
      canvas.removeEventListener('touchmove', move);
      canvas.removeEventListener('touchend', end);
    };
  }, []);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      style={{ display: 'block', border: '1px solid #cbd5e1', borderRadius: 4, touchAction: 'none', cursor: 'crosshair', maxWidth: '100%', height: 'auto', ...style }}
      aria-label="Draw your signature"
    />
  );
});

export default SignatureCanvas;
