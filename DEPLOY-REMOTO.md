# Deploys remotos desde Cowork — receta que funciona

Cómo dejar a Claude pusheando a estos repos desde un chat de Cowork.
Probado en `pps-inventario`; aplica igual acá.

## 1 · El proxy (la parte que rompe todo si falta)

El contenedor sale a internet por un proxy (`https_proxy`). Git lo respeta y el
push a GitHub falla, cuelga, o devuelve un 403 que **no viene de GitHub**. Hay
que decirle a git que para GitHub no lo use:

    git config --global http.https://github.com/.proxy ""
    git config --get http.https://github.com/.proxy    # debe imprimir vacío

Si en un chat nuevo el push falla, esto es lo PRIMERO que hay que mirar.

## 2 · La credencial

    umask 077
    printf 'https://x-access-token:%s@github.com\n' '<TOKEN>' > ~/.git-credentials
    chmod 600 ~/.git-credentials
    git config --global credential.helper store

El usuario literal `x-access-token` es a propósito: con un PAT, GitHub ignora el
nombre de usuario y lee el token de la contraseña.

## 3 · Identidad y firma — NO TOCAR

Cowork fija `user.name=Claude` y `user.email=noreply@anthropic.com` y firma con
una llave SSH propia registrada a ese correo. Si se cambia el correo del
committer, GitHub muestra los commits como "Unverified" aunque la firma sea válida.

## 4 · El token (lo único que hace José)

GitHub → Settings → Developer settings → Personal access tokens → Fine-grained:

- Repository access: **Only select repositories** → sólo los repos necesarios.
- Permissions → Repository permissions: únicamente **Contents: Read and write**.
- Expiration: **7 días** (30 como máximo).

**El token queda en el transcripto del chat** — el contenedor no tiene otra puerta
de entrada. Nace quemado: alcance mínimo, vencimiento corto, y **revocarlo al
terminar la sesión** aunque no haya vencido.

## ⚠️ La trampa: no verifiques con curl

`curl` contra `api.github.com` sale por el proxy del contenedor, que tiene su
propia sesión de GitHub y **contesta por su cuenta** — devuelve 403 y mensajes
como *"sessions are bound to their configured repositories"*, que no son de
GitHub. Concluir desde ahí que el token está vencido es un error.

**Git sale directo, curl sale por el proxy. Lo que diga curl sobre tu token no es
sobre tu token.** La única prueba válida:

    timeout 60 git push --dry-run origin main

`Everything up-to-date` o una línea `abc123..def456 main -> main` = sano.
`Authentication failed` / 403 / cuelgue = token o proxy, en ese orden.

Las variables `GH_TOKEN` y `GITHUB_TOKEN` del entorno **no son tuyas** — son del
proxy. Ignorarlas.

## Qué se despliega solo y qué no

| Componente | Repo | Disparo | Verificación |
|---|---|---|---|
| Server (Railway) | `estancia5m-api` | push a `main` → deploy automático | `curl -s $API/ \| grep version` o Railway MCP |
| Desktop (Electron) | `estancia5m-electron` | push + `git tag vX.Y.Z` | badge en Configuración + `grep` del marker |
| EP Campo / EP Agro | — | **manual**: arrastrar zip a Netlify | badge en el header |

## Reglas de la casa

1. **Nunca pushear sin tests verdes** — el conteo va en el mensaje de commit.
2. **Server primero**, después Desktop, después las PWAs.
3. Los markers greppables (`tareas-v18179`, `borrado-agro-v18180`) verifican el
   deploy sin abrir la app.
4. Rollback: `git revert <sha> && git push`, o re-taggear la versión anterior.
5. Railway MCP disponible en sesión: logs de prod, estado, variables, redeploy.
