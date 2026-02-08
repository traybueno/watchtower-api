import { Hono } from 'hono'
import type { Env } from '../index'

export const hostingRouter = new Hono<{ Bindings: Env }>()

// Max upload size: 100MB
const MAX_UPLOAD_SIZE = 100 * 1024 * 1024

// Check if R2 is configured
hostingRouter.use('*', async (c, next) => {
  if (!c.env.GAMES) {
    return c.json({ error: 'Hosting not enabled - R2 storage not configured' }, 503)
  }
  await next()
})

// POST /v1/hosting/upload - Upload a game build (ZIP or individual files)
hostingRouter.post('/upload', async (c) => {
  const gameId = c.get('gameId' as never) as string
  const projectId = c.get('projectId' as never) as string
  
  const contentType = c.req.header('Content-Type') || ''
  
  // Handle multipart form upload (drag & drop from dashboard)
  if (contentType.includes('multipart/form-data')) {
    const formData = await c.req.formData()
    const files = formData.getAll('files') as unknown as File[]
    
    if (!files || files.length === 0) {
      return c.json({ error: 'No files provided' }, 400)
    }
    
    // Get file paths and strip common folder prefix (e.g., "my-game/index.html" -> "index.html")
    let filePaths = files.map(f => f.name)
    
    // Check if all files share a common prefix folder
    if (filePaths.length > 0) {
      const firstSlash = filePaths[0]?.indexOf('/')
      if (firstSlash > 0) {
        const commonPrefix = filePaths[0].substring(0, firstSlash + 1)
        const allSharePrefix = filePaths.every(p => p.startsWith(commonPrefix))
        
        if (allSharePrefix) {
          // Strip the common folder prefix
          filePaths = filePaths.map(p => p.substring(commonPrefix.length))
        }
      }
    }
    
    // Check for index.html (after stripping prefix)
    const hasIndex = filePaths.some(f => f === 'index.html' || f.endsWith('/index.html'))
    if (!hasIndex) {
      return c.json({ error: 'Missing index.html - upload must include an index.html file' }, 400)
    }
    
    // Calculate total size
    const totalSize = files.reduce((sum, f) => sum + f.size, 0)
    if (totalSize > MAX_UPLOAD_SIZE) {
      return c.json({ error: `Upload too large: ${(totalSize / 1024 / 1024).toFixed(1)}MB (max 100MB)` }, 400)
    }
    
    // Upload all files to R2 (using normalized paths)
    const prefix = `games/${projectId}/`
    const uploaded: string[] = []
    
    for (let i = 0; i < files.length; i++) {
      const file = files[i]
      const normalizedPath = filePaths[i]
      const key = `${prefix}${normalizedPath}`
      const arrayBuffer = await file.arrayBuffer()
      
      await c.env.GAMES!.put(key, arrayBuffer, {
        httpMetadata: {
          contentType: getMimeType(normalizedPath)
        }
      })
      
      uploaded.push(normalizedPath)
    }
    
    // Get or create subdomain
    let subdomain = await getSubdomain(c.env, projectId)
    if (!subdomain) {
      subdomain = generateSubdomain()
    }
    // Always write to both Supabase and KV (ensures KV is populated on redeploy)
    await setSubdomain(c.env, projectId, subdomain)
    
    return c.json({
      success: true,
      files: uploaded.length,
      size: totalSize,
      url: `https://${subdomain}.watchtower.host`,
      subdomain
    })
  }
  
  // Handle ZIP upload
  if (contentType.includes('application/zip') || contentType.includes('application/x-zip')) {
    const arrayBuffer = await c.req.arrayBuffer()
    
    if (arrayBuffer.byteLength > MAX_UPLOAD_SIZE) {
      return c.json({ error: `Upload too large: ${(arrayBuffer.byteLength / 1024 / 1024).toFixed(1)}MB (max 100MB)` }, 400)
    }
    
    // Extract ZIP (using streaming decompression)
    const files = await extractZip(arrayBuffer)
    
    if (files.length === 0) {
      return c.json({ error: 'ZIP file is empty or corrupted' }, 400)
    }
    
    // Check for index.html
    const hasIndex = files.some(f => f.path === 'index.html' || f.path.endsWith('/index.html'))
    if (!hasIndex) {
      return c.json({ error: 'Missing index.html - ZIP must contain an index.html file' }, 400)
    }
    
    // Upload all files to R2
    const prefix = `games/${projectId}/`
    
    for (const file of files) {
      const key = `${prefix}${file.path}`
      await c.env.GAMES!.put(key, file.data, {
        httpMetadata: {
          contentType: getMimeType(file.path)
        }
      })
    }
    
    // Get or create subdomain
    let subdomain = await getSubdomain(c.env, projectId)
    if (!subdomain) {
      subdomain = generateSubdomain()
    }
    // Always write to both Supabase and KV (ensures KV is populated on redeploy)
    await setSubdomain(c.env, projectId, subdomain)
    
    const totalSize = files.reduce((sum, f) => sum + f.data.byteLength, 0)
    
    return c.json({
      success: true,
      files: files.length,
      size: totalSize,
      url: `https://${subdomain}.watchtower.host`,
      subdomain
    })
  }
  
  return c.json({ error: 'Invalid content type. Use multipart/form-data or application/zip' }, 400)
})

// GET /v1/hosting/status - Get hosting status for project
hostingRouter.get('/status', async (c) => {
  const projectId = c.get('projectId' as never) as string
  
  console.log(`[STATUS] projectId=${projectId}`)
  const subdomain = await getSubdomain(c.env, projectId)
  console.log(`[STATUS] subdomain=${subdomain}`)
  
  // List files to check if currently published
  const prefix = `games/${projectId}/`
  const list = await c.env.GAMES!.list({ prefix, limit: 1000 })
  const hasFiles = list.objects.length > 0
  console.log(`[STATUS] Found ${list.objects.length} files, hasFiles=${hasFiles}`)
  
  if (!subdomain) {
    // Never published - no permanent URL yet
    console.log(`[STATUS] No subdomain yet (never published)`)
    return c.json({
      enabled: false,
      url: null,
      subdomain: null
    })
  }
  
  const totalSize = list.objects.reduce((sum, obj) => sum + (obj.size || 0), 0)
  
  // Return permanent subdomain even if unpublished (no files)
  return c.json({
    enabled: hasFiles,  // Only "enabled" if files exist
    url: `https://${subdomain}.watchtower.host`,
    subdomain,          // Always return the permanent subdomain
    files: list.objects.length,
    size: totalSize,
    truncated: list.truncated
  })
})

// DELETE /v1/hosting - Remove all hosted files
hostingRouter.delete('/', async (c) => {
  const projectId = c.get('projectId' as never) as string
  
  // Get subdomain before deleting
  const subdomain = await getSubdomain(c.env, projectId)
  console.log(`[DELETE] projectId=${projectId}, subdomain=${subdomain}`)
  
  // List and delete all files
  const prefix = `games/${projectId}/`
  let cursor: string | undefined
  let deleted = 0
  
  do {
    const list = await c.env.GAMES!.list({ prefix, cursor, limit: 1000 })
    console.log(`[DELETE] Found ${list.objects.length} files to delete`)
    
    for (const obj of list.objects) {
      await c.env.GAMES!.delete(obj.key)
      deleted++
    }
    
    cursor = list.truncated ? list.cursor : undefined
  } while (cursor)
  
  // Clear KV cache only - keep Supabase record for permanent URL
  if (subdomain) {
    console.log(`[DELETE] Clearing KV cache for ${subdomain} (keeping permanent URL)`)
    await clearKvCache(c.env, subdomain)
  }
  
  // Subdomain should still exist in Supabase (permanent)
  const checkSubdomain = await getSubdomain(c.env, projectId)
  console.log(`[DELETE] After unpublish, subdomain=${checkSubdomain} (should be preserved)`)
  
  return c.json({
    success: true,
    deleted,
    subdomain: subdomain || null,
    // URL is preserved, just files are removed
    urlPreserved: checkSubdomain !== null
  })
})

// POST /v1/hosting/subdomain - Set custom subdomain
hostingRouter.post('/subdomain', async (c) => {
  const projectId = c.get('projectId' as never) as string
  const body = await c.req.json() as { subdomain: string, oldSubdomain?: string }
  const { subdomain, oldSubdomain: clientOldSubdomain } = body
  
  // Validate subdomain format (3-63 chars, alphanumeric + hyphens, no leading/trailing hyphen)
  if (!subdomain || subdomain.length < 3 || subdomain.length > 63) {
    return c.json({ error: 'Subdomain must be 3-63 characters' }, 400)
  }
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(subdomain)) {
    return c.json({ error: 'Use letters, numbers, hyphens (no leading/trailing hyphen)' }, 400)
  }
  
  const normalized = subdomain.toLowerCase()
  
  // Check reserved names
  const reserved = ['www', 'api', 'app', 'dashboard', 'docs', 'help', 'support', 'admin', 'mail', 'cdn']
  if (reserved.includes(normalized)) {
    return c.json({ error: 'This subdomain is reserved' }, 400)
  }
  
  // Check if already taken
  const existing = await c.env.SAVES.get(`subdomain:${normalized}`)
  if (existing && existing !== projectId) {
    return c.json({ error: 'This subdomain is already taken' }, 400)
  }
  
  // Get old subdomain to clean up (from Supabase, with client fallback)
  const supabaseOldSubdomain = await getSubdomain(c.env, projectId)
  const oldSubdomain = supabaseOldSubdomain || clientOldSubdomain
  
  console.log(`[SUBDOMAIN] Changing ${oldSubdomain} -> ${normalized} for project ${projectId}`)
  
  // Delete old KV entry so old URL returns 404
  if (oldSubdomain && oldSubdomain !== normalized) {
    console.log(`[SUBDOMAIN] Deleting KV entry for old subdomain: ${oldSubdomain}`)
    await c.env.SAVES.delete(`subdomain:${oldSubdomain}`)
  }
  
  // Set new subdomain (writes to Supabase + KV)
  await setSubdomain(c.env, projectId, normalized)
  
  return c.json({
    success: true,
    url: `https://${normalized}.watchtower.host`,
    subdomain: normalized
  })
})

// Helper functions

function generateSubdomain(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let result = ''
  for (let i = 0; i < 8; i++) {
    result += chars[Math.floor(Math.random() * chars.length)]
  }
  return result
}

async function getSubdomain(env: Env, projectId: string): Promise<string | null> {
  // Query Supabase for subdomain
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    console.error('Supabase not configured')
    return null
  }
  
  try {
    const response = await fetch(
      `${env.SUPABASE_URL}/rest/v1/hosted_sites?project_id=eq.${projectId}&select=subdomain`,
      {
        headers: {
          'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
          'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
        }
      }
    )
    
    if (response.ok) {
      const rows = await response.json() as Array<{ subdomain: string }>
      return rows[0]?.subdomain || null
    }
  } catch (e) {
    console.error('Failed to get subdomain:', e)
  }
  
  return null
}

async function setSubdomain(env: Env, projectId: string, subdomain: string): Promise<void> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase not configured')
  }
  
  // Upsert to Supabase
  const response = await fetch(
    `${env.SUPABASE_URL}/rest/v1/hosted_sites`,
    {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'resolution=merge-duplicates'
      },
      body: JSON.stringify({
        project_id: projectId,
        subdomain: subdomain,
        updated_at: new Date().toISOString()
      })
    }
  )
  
  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Failed to set subdomain: ${error}`)
  }
  
  // Also write to KV for fast edge serving
  await env.SAVES.put(`subdomain:${subdomain}`, projectId)
}

async function clearSubdomain(env: Env, projectId: string): Promise<void> {
  // Get subdomain first
  const subdomain = await getSubdomain(env, projectId)
  
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) {
    throw new Error('Supabase not configured')
  }
  
  // Delete from Supabase
  await fetch(
    `${env.SUPABASE_URL}/rest/v1/hosted_sites?project_id=eq.${projectId}`,
    {
      method: 'DELETE',
      headers: {
        'apikey': env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`
      }
    }
  )
  
  // Clean up KV
  if (subdomain) {
    await env.SAVES.delete(`subdomain:${subdomain}`)
  }
}

// Clear KV cache only - keeps Supabase record (for permanent URLs)
async function clearKvCache(env: Env, subdomain: string): Promise<void> {
  await env.SAVES.delete(`subdomain:${subdomain}`)
}

function getMimeType(filename: string): string {
  const ext = filename.split('.').pop()?.toLowerCase()
  const mimeTypes: Record<string, string> = {
    // Web
    'html': 'text/html',
    'htm': 'text/html',
    'css': 'text/css',
    'js': 'application/javascript',
    'mjs': 'application/javascript',
    'json': 'application/json',
    'xml': 'application/xml',
    'wasm': 'application/wasm',
    
    // Images
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif',
    'webp': 'image/webp',
    'svg': 'image/svg+xml',
    'ico': 'image/x-icon',
    
    // Audio
    'mp3': 'audio/mpeg',
    'ogg': 'audio/ogg',
    'wav': 'audio/wav',
    'webm': 'audio/webm',
    
    // Fonts
    'woff': 'font/woff',
    'woff2': 'font/woff2',
    'ttf': 'font/ttf',
    'otf': 'font/otf',
    
    // Data
    'bin': 'application/octet-stream',
    'data': 'application/octet-stream',
    'glb': 'model/gltf-binary',
    'gltf': 'model/gltf+json',
  }
  
  return mimeTypes[ext || ''] || 'application/octet-stream'
}

// Simple ZIP extraction (no external deps)
// Handles basic ZIP files with DEFLATE or STORE compression
interface ZipFile {
  path: string
  data: Uint8Array
}

async function extractZip(buffer: ArrayBuffer): Promise<ZipFile[]> {
  const data = new Uint8Array(buffer)
  const files: ZipFile[] = []
  
  let offset = 0
  
  while (offset < data.length - 4) {
    // Local file header signature
    if (data[offset] === 0x50 && data[offset + 1] === 0x4b && 
        data[offset + 2] === 0x03 && data[offset + 3] === 0x04) {
      
      const view = new DataView(buffer, offset)
      
      const compression = view.getUint16(8, true)
      const compressedSize = view.getUint32(18, true)
      const uncompressedSize = view.getUint32(22, true)
      const nameLength = view.getUint16(26, true)
      const extraLength = view.getUint16(28, true)
      
      const nameStart = offset + 30
      const nameBytes = data.slice(nameStart, nameStart + nameLength)
      const filename = new TextDecoder().decode(nameBytes)
      
      const dataStart = nameStart + nameLength + extraLength
      const fileData = data.slice(dataStart, dataStart + compressedSize)
      
      // Skip directories
      if (!filename.endsWith('/')) {
        let extractedData: Uint8Array
        
        if (compression === 0) {
          // STORE (no compression)
          extractedData = fileData
        } else if (compression === 8) {
          // DEFLATE
          extractedData = await inflate(fileData)
        } else {
          // Skip unsupported compression
          offset = dataStart + compressedSize
          continue
        }
        
        // Normalize path (remove leading slashes, __MACOSX, etc.)
        let path = filename.replace(/^\/+/, '')
        if (path.startsWith('__MACOSX/') || path.startsWith('.')) {
          offset = dataStart + compressedSize
          continue
        }
        
        // If everything is in a single folder, flatten it
        files.push({ path, data: extractedData })
      }
      
      offset = dataStart + compressedSize
    } else {
      offset++
    }
  }
  
  // Check if all files share a common prefix folder (e.g., "build/")
  if (files.length > 0) {
    const paths = files.map(f => f.path)
    const firstSlash = paths[0]?.indexOf('/')
    
    if (firstSlash > 0) {
      const prefix = paths[0].substring(0, firstSlash + 1)
      const allSharePrefix = paths.every(p => p.startsWith(prefix))
      
      if (allSharePrefix) {
        // Strip the common prefix
        for (const file of files) {
          file.path = file.path.substring(prefix.length)
        }
      }
    }
  }
  
  return files
}

// DEFLATE decompression using DecompressionStream (available in Workers)
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  // Add zlib header for raw deflate data
  const zlibData = new Uint8Array(data.length + 2)
  zlibData[0] = 0x78
  zlibData[1] = 0x9c
  zlibData.set(data, 2)
  
  try {
    const ds = new DecompressionStream('deflate')
    const writer = ds.writable.getWriter()
    writer.write(data)
    writer.close()
    
    const reader = ds.readable.getReader()
    const chunks: Uint8Array[] = []
    
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
    }
    
    const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const result = new Uint8Array(totalLength)
    let offset = 0
    
    for (const chunk of chunks) {
      result.set(chunk, offset)
      offset += chunk.length
    }
    
    return result
  } catch {
    // If that fails, try with deflate-raw
    try {
      const ds = new DecompressionStream('deflate-raw')
      const writer = ds.writable.getWriter()
      writer.write(data)
      writer.close()
      
      const reader = ds.readable.getReader()
      const chunks: Uint8Array[] = []
      
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }
      
      const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
      const result = new Uint8Array(totalLength)
      let offset = 0
      
      for (const chunk of chunks) {
        result.set(chunk, offset)
        offset += chunk.length
      }
      
      return result
    } catch {
      // Return original data if all decompression fails
      return data
    }
  }
}
