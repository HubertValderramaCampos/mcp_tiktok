# Referencia de herramientas

Todas las herramientas devuelven JSON. Si una operación falla, responden con un error que describe la causa.

## tiktok_login

Abre el navegador para iniciar sesión manualmente. Solo hace falta una vez.

| Parámetro | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `timeout_minutes` | número | `5` | Tiempo de espera, de 1 a 15 minutos |

## tiktok_list_videos

Lista los videos de la cuenta, del más reciente al más antiguo.

| Parámetro | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `limit` | número | `20` | Cantidad de videos, de 1 a 500 |

```json
{
  "count": 1,
  "complete": false,
  "videos": [
    {
      "id": "7600000000000000000",
      "description": "Mi video",
      "url": "https://www.tiktok.com/video/7600000000000000000",
      "created_at": "2026-08-05T00:42:51.000Z",
      "duration_s": 35,
      "visibility": "public",
      "views": 736,
      "likes": 24,
      "comments": 0,
      "shares": 6,
      "favorites": 6
    }
  ]
}
```

`visibility` puede ser `public`, `friends` o `private`.

## tiktok_get_video

Devuelve las métricas de un video de la cuenta, con el mismo formato de `tiktok_list_videos`.

| Parámetro | Tipo | Descripción |
|---|---|---|
| `video_id` | texto | Identificador numérico del video |

## tiktok_account_stats

Devuelve seguidores, seguidos y likes de una cuenta pública. No requiere sesión.

| Parámetro | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `username` | texto | `TIKTOK_USERNAME` | Usuario sin `@` |

Los valores se devuelven como los muestra TikTok, por ejemplo `14K`.

## tiktok_upload_video

Sube un video desde un archivo local.

| Parámetro | Tipo | Por defecto | Descripción |
|---|---|---|---|
| `path` | texto | Obligatorio | Ruta absoluta a un `.mp4`, `.mov` o `.webm` |
| `caption` | texto | Vacío | Descripción, hasta 4000 caracteres |
| `privacy` | texto | `private` | `private`, `friends` o `public` |
| `publish` | booleano | `false` | `true` publica el video |

Con `publish=false`, el servidor llena el formulario, guarda una captura y descarta la subida:

```json
{
  "published": false,
  "privacy": "Only you",
  "screenshot": "/data/screenshots/upload-preview.png",
  "note": "Prueba: formulario completo, sin publicar. Al cerrar la pagina se descarta."
}
```

Con `publish=true`, `published` vale `true` cuando TikTok confirma la publicación. Si vale `unconfirmed`, revisa la captura antes de reintentar.

## tiktok_post_comment

Publica un comentario con la cuenta iniciada.

| Parámetro | Tipo | Descripción |
|---|---|---|
| `video_url` | texto | URL con formato `https://www.tiktok.com/@usuario/video/ID` |
| `text` | texto | Comentario de 1 a 150 caracteres |
