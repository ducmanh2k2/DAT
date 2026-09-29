// App.js
import React from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';

import ToolDat from './component/toolDat'

import './index.css';

function App() {
  return (
    <ToolDat/>
    // <Router>
    //   <div className="App">
    //     <Routes>
    //       <Route path="/" element={<HomePage />} />
    //       <Route path="/courses" element={<CoursesPage />} />
    //       <Route path="/trainees" element={<TraineesPage />} />
    //     </Routes>
    //   </div>
    // </Router>
  );
}

export default App;