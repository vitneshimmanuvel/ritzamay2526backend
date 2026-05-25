// Polyfill browser-only globals for pdf-parse inside Node/Vercel serverless environment
if (typeof global !== 'undefined') {
  if (!(global as any).DOMMatrix) {
    (global as any).DOMMatrix = class DOMMatrix {
      constructor() {}
    };
  }
  if (!(global as any).ImageData) {
    (global as any).ImageData = class ImageData {
      constructor() {}
    };
  }
  if (!(global as any).Path2D) {
    (global as any).Path2D = class Path2D {
      constructor() {}
    };
  }
}

// Load the Express app sequentially to prevent ESModule import hoisting
const app = require('../src/server').default || require('../src/server');

export default app;
module.exports = app;
