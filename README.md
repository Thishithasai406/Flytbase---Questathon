# AccountOS

Monday brief for two accounts. It reads a saved copy of the account record and checks live signals through the MCP server.

## Run

```bash
npm install
```

Put the token in `.env` on the server only:

```
AQ_TOKEN=your-token
```

```bash
npm start
```

Open http://localhost:3001.

The token is not in the browser code. The page calls this server. This server calls the MCP.
