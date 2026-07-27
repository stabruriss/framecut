import '@fontsource-variable/archivo';
import '@fontsource-variable/newsreader';
import { createRoot } from 'react-dom/client';
import App from './App';
import { SingleTiffWorkerClient } from './lib/single-tiff-worker-client';
import './styles.css';

const createEngine = () => new SingleTiffWorkerClient();

createRoot(document.getElementById('root')!).render(
  <App createEngine={createEngine} processingSupported />,
);
