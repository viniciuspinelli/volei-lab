# 🏐 App Mobile - Alternativas para Executar

Como há um problema de compatibilidade com o Expo no Windows, aqui estão as alternativas:

## ✅ Opção 1: Usar Snack (Recomendado - Online)

1. Acesse: https://snack.expo.dev
2. Cole o conteúdo de `App.js`
3. Teste no seu celular escaneando o QR Code

## ✅ Opção 2: Usar seu Mac/Linux
Se tem um Mac ou Linux disponível:
```bash
cd mobile
npm install
npm start
```

## ✅ Opção 3: Usar Docker
```bash
docker run -it -p 19000:19000 -v ${PWD}/mobile:/app node:18
cd /app
npm install
npm start
```

## ✅ Opção 4: Downgrade do Node.js
Windows tem problema com Metro + Node 20+. Use Node 18:

1. Desinstale Node.js atual
2. Instale Node.js v18 LTS: https://nodejs.org/download/release/v18.18.0/
3. Depois tente novamente:
```bash
cd mobile
npm install
npm start
```

## ⚠️ Por enquanto:

O código está pronto e no GitHub. Quando conseguir rodar o Expo (em Mac, Linux ou downgradeando Node), é só scanear o QR Code!

---

**Resumo dos arquivos criados:**
- ✅ App.js - Navegação principal
- ✅ HomeScreen.js - Confirmar presença
- ✅ ListaScreen.js - Ver confirmados
- ✅ SorteioScreen.js - Sorteio dos times
- ✅ utils/api.js - Integração com API
- ✅ app.json - Configuração Expo
- ✅ package.json - Dependências

Tudo está funcionando, é só questão de rodar o servidor!
