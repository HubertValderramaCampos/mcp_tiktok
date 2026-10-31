# Guía de Docker

La imagen incluye Brave, una pantalla virtual y una vista remota por navegador. Así el servidor puede ejecutarse en cualquier equipo con Docker, incluso sin entorno gráfico.

## Construir la imagen

```bash
docker build -t mcp-tiktok .
```

## Ejecutar

Normalmente el cliente MCP inicia el contenedor. Para probarlo a mano:

```bash
docker run -i --rm \
  -v mcp-tiktok-data:/data \
  -v /ruta/a/tus/videos:/videos:ro \
  -p 127.0.0.1:6080:6080 \
  mcp-tiktok
```

| Opción | Función |
|---|---|
| `-i` | Mantiene abierta la entrada estándar; MCP la necesita |
| `-v mcp-tiktok-data:/data` | Conserva la sesión y las capturas |
| `-v /ruta/a/tus/videos:/videos:ro` | Da acceso de solo lectura a tus videos |
| `-p 127.0.0.1:6080:6080` | Publica la vista remota solo en tu equipo |

En Windows, la ruta de videos puede escribirse como `C:\Users\tu-usuario\Videos:/videos:ro`.

## Iniciar sesión

1. Ejecuta `tiktok_login` desde tu cliente MCP.
2. Abre <http://localhost:6080/vnc.html> y pulsa **Connect**.
3. Inicia sesión con el código QR desde la app de TikTok.

La vista remota solo está disponible mientras el contenedor esté en marcha.

## Subir videos

Dentro del contenedor, las rutas son las del volumen montado. Si `demo.mp4` está en tu carpeta de videos, usa:

```text
/videos/demo.mp4
```

## Usarlo en un servidor

No publiques el puerto 6080 en internet. Conéctate con un túnel SSH y abre la misma dirección en tu equipo:

```bash
ssh -L 6080:127.0.0.1:6080 usuario@tu-servidor
```

TikTok puede pedir más verificaciones desde direcciones IP de centros de datos. Si aparece un captcha, resuélvelo desde la vista remota.

## Notas

- La imagen ocupa cerca de 2 GB, porque incluye un navegador completo.
- El contenedor desactiva el sandbox de Chromium (`TIKTOK_NO_SANDBOX=1`), que no arranca con el perfil de seguridad por defecto de Docker. Úsalo solo con tu propia cuenta.
- El contenedor funciona como un usuario sin privilegios.
- Para borrar la sesión, elimina el volumen: `docker volume rm mcp-tiktok-data`.
