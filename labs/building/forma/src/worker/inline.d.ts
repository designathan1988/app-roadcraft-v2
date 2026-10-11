// Importação de worker embutido do Vite (`?worker&inline`).
declare module '*?worker&inline' {
  const WorkerConstructor: new () => Worker;
  export default WorkerConstructor;
}
