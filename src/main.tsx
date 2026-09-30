import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { prepararAcesso } from './api/client.ts'

// Pede ao launcher a porta e o token desta execução **antes** da primeira requisição: no
// app instalado a porta é efêmera, então a tela não pode abrir falando com a 8787. A
// promessa é idempotente e a tela não espera por ela — cada requisição espera sozinha.
void prepararAcesso()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
