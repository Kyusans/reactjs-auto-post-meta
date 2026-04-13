import './App.css';

import { MainPage } from './pages/MainPage';
import { Toaster } from 'sonner';

function App() {

  return (
    <div className="App">
      <Toaster />
      <MainPage />
    </div>
  );
}

export default App;
