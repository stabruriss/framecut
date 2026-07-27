import '@fontsource-variable/archivo';
import '@fontsource-variable/newsreader';
import { createRoot } from 'react-dom/client';
import App from './App';
import { TiffWorkerClient } from './lib/tiff-worker-client';
import './styles.css';

const createEngine = () => new TiffWorkerClient();

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(
      `${import.meta.env.BASE_URL}sw.js`,
    );
  });
}

createRoot(document.getElementById('root')!).render(
  <App
    createEngine={createEngine}
    processingSupported={window.crossOriginIsolated}
    unsupportedMessage="COOP/COEP headers are missing. The WASM engine cannot start."
  />,
);
