// === mesh.ts ===
// Geometry helpers: vec3, mat4, mesh primitives, OBJ loader

// --- Vec3 helpers ---

function _cross(a, b) {
  return [
    a[1]*b[2] - a[2]*b[1],
    a[2]*b[0] - a[0]*b[2],
    a[0]*b[1] - a[1]*b[0],
  ];
}

function _sub(a, b) {
  return [a[0]-b[0], a[1]-b[1], a[2]-b[2]];
}

function _normalize(v) {
  const len = Math.sqrt(v[0]*v[0] + v[1]*v[1] + v[2]*v[2]);
  return [v[0]/len, v[1]/len, v[2]/len];
}

// --- Mat4 helpers (column-major) ---

function _mat4Identity() {
  return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
}
function _mat4Multiply(a, b) {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++)
    for (let row = 0; row < 4; row++)
      out[col*4+row] = a[0*4+row]*b[col*4+0] + a[1*4+row]*b[col*4+1] + a[2*4+row]*b[col*4+2] + a[3*4+row]*b[col*4+3];
  return out;
}
function _mat4Translate(x, y, z) { const m = _mat4Identity(); m[12]=x; m[13]=y; m[14]=z; return m; }
function _mat4Scale(s)            { const m = _mat4Identity(); m[0]=s; m[5]=s; m[10]=s; return m; }
function _mat4RotateX(r) { const c=Math.cos(r), s=Math.sin(r), m=_mat4Identity(); m[5]=c; m[9]=-s; m[6]=s; m[10]=c; return m; }
function _mat4RotateY(r) { const c=Math.cos(r), s=Math.sin(r), m=_mat4Identity(); m[0]=c; m[8]=s; m[2]=-s; m[10]=c; return m; }
function _mat4RotateZ(r) { const c=Math.cos(r), s=Math.sin(r), m=_mat4Identity(); m[0]=c; m[4]=-s; m[1]=s; m[5]=c; return m; }

// Inverse of a TRS matrix (uniform scale assumed).
// inv(T*R*S) upper-3x3 = (R*S)^T / s^2, translation = -upper3x3_inv * t
function _mat4InverseTRS(m) {
  const s2 = m[0]*m[0] + m[1]*m[1] + m[2]*m[2]; // |col0|^2 = scale^2
  const inv = new Float32Array(16);
  inv[0]  = m[0]/s2;  inv[4]  = m[1]/s2;  inv[8]  = m[2]/s2;
  inv[1]  = m[4]/s2;  inv[5]  = m[5]/s2;  inv[9]  = m[6]/s2;
  inv[2]  = m[8]/s2;  inv[6]  = m[9]/s2;  inv[10] = m[10]/s2;
  inv[12] = -(inv[0]*m[12] + inv[4]*m[13] + inv[8]*m[14]);
  inv[13] = -(inv[1]*m[12] + inv[5]*m[13] + inv[9]*m[14]);
  inv[14] = -(inv[2]*m[12] + inv[6]*m[13] + inv[10]*m[14]);
  inv[15] = 1;
  return inv;
}

// Build a TRS matrix from { translation:[x,y,z], rotation:[rx,ry,rz], scale:s }
function get_mat({ translation: [tx,ty,tz], rotation: [rx,ry,rz], scale: s }) {
  return _mat4Multiply(_mat4Translate(tx,ty,tz),
    _mat4Multiply(_mat4RotateY(ry),
      _mat4Multiply(_mat4RotateX(rx),
        _mat4Multiply(_mat4RotateZ(rz), _mat4Scale(s)))));
}

// --- Mesh primitives ---

// UV sphere centered at origin
function create_sphere(radius, latRes, lonRes, color) {
  const positions = [], normals = [], uvs = [], colors = [], indices = [];
  for (let lat = 0; lat <= latRes; lat++) {
    const theta = lat * Math.PI / latRes;
    const sinT = Math.sin(theta), cosT = Math.cos(theta);
    for (let lon = 0; lon <= lonRes; lon++) {
      const phi = lon * 2 * Math.PI / lonRes;
      const x = Math.cos(phi) * sinT, y = cosT, z = Math.sin(phi) * sinT;
      positions.push(radius * x, radius * y, radius * z);
      normals.push(x, y, z);
      uvs.push(lon / lonRes, 1 - lat / latRes);
      colors.push(color[0], color[1], color[2]);
    }
  }
  for (let lat = 0; lat < latRes; lat++) {
    for (let lon = 0; lon < lonRes; lon++) {
      const a = lat * (lonRes + 1) + lon;
      const b = a + lonRes + 1;
      indices.push(a, a + 1, b, b, a + 1, b + 1);
    }
  }
  return {
    positions: new Float32Array(positions), normals: new Float32Array(normals),
    uvs: new Float32Array(uvs), colors: new Float32Array(colors), indices: new Uint32Array(indices),
  };
}

// 4 corners -> 2-triangle mesh with auto-computed flat normal
// a, b, c, d: [x,y,z] arrays, color: [r,g,b]
function create_quad(a, b, c, d, color) {
  const normal = _normalize(_cross(_sub(a, b), _sub(a, d)));

  return {
    positions: new Float32Array([...a, ...b, ...c, ...d]),
    normals:   new Float32Array([...normal, ...normal, ...normal, ...normal]),
    uvs:       new Float32Array([0,0, 1,0, 1,1, 0,1]),
    colors:    new Float32Array([...color, ...color, ...color, ...color]),
    indices:   new Uint32Array([0,1,2, 0,2,3]),
  };
}

function merge_meshes(meshes) {
  const positions = [], normals = [], uvs = [], colors = [], indices = [];
  let vertexOffset = 0;

  for (const mesh of meshes) {
    for (let i = 0; i < mesh.positions.length; i++) positions.push(mesh.positions[i]);
    for (let i = 0; i < mesh.normals.length; i++)   normals.push(mesh.normals[i]);
    for (let i = 0; i < mesh.uvs.length; i++)        uvs.push(mesh.uvs[i]);
    for (let i = 0; i < mesh.colors.length; i++)     colors.push(mesh.colors[i]);
    for (let i = 0; i < mesh.indices.length; i++)    indices.push(mesh.indices[i] + vertexOffset);
    vertexOffset += mesh.positions.length / 3;
  }

  return {
    positions: new Float32Array(positions),
    normals:   new Float32Array(normals),
    uvs:       new Float32Array(uvs),
    colors:    new Float32Array(colors),
    indices:   new Uint32Array(indices),
  };
}

// Apply a column-major mat4 to a mesh.
// Positions: w=1, normals: upper 3x3 + renormalize.
function transformMesh(mesh, m) {
  const newPos  = new Float32Array(mesh.positions.length);
  const newNorm = new Float32Array(mesh.normals.length);

  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i], y = mesh.positions[i+1], z = mesh.positions[i+2];
    newPos[i]   = m[0]*x + m[4]*y + m[8]*z  + m[12];
    newPos[i+1] = m[1]*x + m[5]*y + m[9]*z  + m[13];
    newPos[i+2] = m[2]*x + m[6]*y + m[10]*z + m[14];
  }

  for (let i = 0; i < mesh.normals.length; i += 3) {
    const nx = mesh.normals[i], ny = mesh.normals[i+1], nz = mesh.normals[i+2];
    let x = m[0]*nx + m[4]*ny + m[8]*nz;
    let y = m[1]*nx + m[5]*ny + m[9]*nz;
    let z = m[2]*nx + m[6]*ny + m[10]*nz;
    const len = Math.sqrt(x*x + y*y + z*z);
    if (len > 0.0001) { x /= len; y /= len; z /= len; }
    newNorm[i] = x; newNorm[i+1] = y; newNorm[i+2] = z;
  }

  return { positions: newPos, normals: newNorm, uvs: mesh.uvs, colors: mesh.colors, indices: mesh.indices };
}

// Parse a Wavefront OBJ string into a Mesh.
// Handles v/vt/vn, fan triangulation, flat normal fallback.
function load_mesh(obj_text, color = [1, 1, 1]) {
  const pos_raw = [], norm_raw = [], uv_raw = [];
  const positions = [], normals = [], uvs = [], colors = [];

  for (const line of obj_text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts[0] === 'v')  { pos_raw.push(+parts[1], +parts[2], +parts[3]); }
    else if (parts[0] === 'vn') { norm_raw.push(+parts[1], +parts[2], +parts[3]); }
    else if (parts[0] === 'vt') { uv_raw.push(+parts[1], +parts[2]); }
    else if (parts[0] === 'f') {
      const verts = parts.slice(1);
      for (let i = 1; i < verts.length - 1; i++) {
        for (const token of [verts[0], verts[i], verts[i + 1]]) {
          const [p, t, n] = token.split('/');
          const pi = (parseInt(p) - 1) * 3;
          positions.push(pos_raw[pi], pos_raw[pi+1], pos_raw[pi+2]);
          if (n) { const ni = (parseInt(n) - 1) * 3; normals.push(norm_raw[ni], norm_raw[ni+1], norm_raw[ni+2]); }
          else   { normals.push(0, 0, 0); }
          if (t) { const ti = (parseInt(t) - 1) * 2; uvs.push(uv_raw[ti], uv_raw[ti+1]); }
          else   { uvs.push(0, 0); }
          colors.push(color[0], color[1], color[2]);
        }
      }
    }
  }

  // Compute flat normals when OBJ has none
  if (norm_raw.length === 0) {
    for (let i = 0; i < positions.length; i += 9) {
      const ax=positions[i+3]-positions[i],   ay=positions[i+4]-positions[i+1], az=positions[i+5]-positions[i+2];
      const bx=positions[i+6]-positions[i],   by=positions[i+7]-positions[i+1], bz=positions[i+8]-positions[i+2];
      const nx=ay*bz-az*by, ny=az*bx-ax*bz, nz=ax*by-ay*bx;
      const len = Math.sqrt(nx*nx + ny*ny + nz*nz) || 1;
      for (let v = 0; v < 3; v++) { normals[i+v*3]=nx/len; normals[i+v*3+1]=ny/len; normals[i+v*3+2]=nz/len; }
    }
  }

  const vertex_count = positions.length / 3;
  const indices = new Uint32Array(vertex_count);
  for (let i = 0; i < vertex_count; i++) indices[i] = i;

  return {
    positions: new Float32Array(positions),
    normals:   new Float32Array(normals),
    uvs:       new Float32Array(uvs),
    colors:    new Float32Array(colors),
    indices,
  };
}

