// === camera.ts ===
// Camera state + controls.

export function initCamera(canvas) {
  return {
    position: [278, 273, -800],
    target:   [278, 273, -799],
    up:       [0, 1, 0],
    fov:      Math.PI / 3,
    aspect:   canvas.width / canvas.height,
    near:     0.1,
    far:      2000,
  };
}

// Returns { forward, right, up } as Float32Arrays — used for uniform packing
export function getCameraBasis(camera) {
  const fx = camera.target[0] - camera.position[0];
  const fy = camera.target[1] - camera.position[1];
  const fz = camera.target[2] - camera.position[2];
  const flen = Math.hypot(fx, fy, fz);
  const forward = new Float32Array([fx/flen, fy/flen, fz/flen]);

  const rx = forward[1]*camera.up[2] - forward[2]*camera.up[1];
  const ry = forward[2]*camera.up[0] - forward[0]*camera.up[2];
  const rz = forward[0]*camera.up[1] - forward[1]*camera.up[0];
  const rlen = Math.hypot(rx, ry, rz);
  const right = new Float32Array([rx/rlen, ry/rlen, rz/rlen]);

  const ux = right[1]*forward[2] - right[2]*forward[1];
  const uy = right[2]*forward[0] - right[0]*forward[2];
  const uz = right[0]*forward[1] - right[1]*forward[0];
  const ulen = Math.hypot(ux, uy, uz);
  const up = new Float32Array([ux/ulen, uy/ulen, uz/ulen]);

  return { forward, right, up };
}

export function pan(camera, dx, dy) {
  const fx = camera.target[0]-camera.position[0];
  const fy = camera.target[1]-camera.position[1];
  const fz = camera.target[2]-camera.position[2];
  const flen = Math.hypot(fx, fy, fz);
  const fwdX = fx/flen, fwdY = fy/flen, fwdZ = fz/flen;

  const rx = fwdY*camera.up[2] - fwdZ*camera.up[1];
  const ry = fwdZ*camera.up[0] - fwdX*camera.up[2];
  const rz = fwdX*camera.up[1] - fwdY*camera.up[0];
  const rlen = Math.hypot(rx, ry, rz);
  const rghtX = rx/rlen, rghtY = ry/rlen, rghtZ = rz/rlen;

  camera.position[0] += rghtX*dx + camera.up[0]*dy;
  camera.position[1] += rghtY*dx + camera.up[1]*dy;
  camera.position[2] += rghtZ*dx + camera.up[2]*dy;
  camera.target[0]   += rghtX*dx + camera.up[0]*dy;
  camera.target[1]   += rghtY*dx + camera.up[1]*dy;
  camera.target[2]   += rghtZ*dx + camera.up[2]*dy;
}

export function moveForward(camera, distance) {
  const { forward } = getCameraBasis(camera);
  for (let i = 0; i < 3; i++) {
    camera.position[i] += forward[i] * distance;
    camera.target[i]   += forward[i] * distance;
  }
}

export function rotateYaw(camera, angle) {
  const { forward } = getCameraBasis(camera);
  const dist = Math.hypot(
    camera.target[0]-camera.position[0],
    camera.target[1]-camera.position[1],
    camera.target[2]-camera.position[2],
  );
  const c = Math.cos(angle), s = Math.sin(angle);
  const fX = forward[0]*c + forward[2]*s;
  const fZ = -forward[0]*s + forward[2]*c;
  camera.target[0] = camera.position[0] + fX * dist;
  camera.target[1] = camera.position[1] + forward[1] * dist;
  camera.target[2] = camera.position[2] + fZ * dist;
}

export function rotatePitch(camera, angle) {
  const { forward, up } = getCameraBasis(camera);
  const dist = Math.hypot(
    camera.target[0]-camera.position[0],
    camera.target[1]-camera.position[1],
    camera.target[2]-camera.position[2],
  );
  const c = Math.cos(angle), s = Math.sin(angle);
  const fX = forward[0]*c + up[0]*s;
  const fY = forward[1]*c + up[1]*s;
  const fZ = forward[2]*c + up[2]*s;
  const len = Math.hypot(fX, fY, fZ);
  camera.target[0] = camera.position[0] + (fX/len) * dist;
  camera.target[1] = camera.position[1] + (fY/len) * dist;
  camera.target[2] = camera.position[2] + (fZ/len) * dist;
}

// Perspective projection — WebGPU NDC: z in [0, 1], column-major
export function mat4Perspective(fovY, aspect, near, far) {
  const f  = 1.0 / Math.tan(fovY / 2);
  const nf = 1   / (near - far);
  const m  = new Float32Array(16);
  m[0]  = f / aspect;
  m[5]  = f;
  m[10] = far * nf;
  m[11] = -1;
  m[14] = far * near * nf;
  return m;
}

// View matrix — column-major
export function mat4LookAt(eye, center, up) {
  const fx = center[0]-eye[0], fy = center[1]-eye[1], fz = center[2]-eye[2];
  const flen = Math.hypot(fx, fy, fz);
  const f0 = fx/flen, f1 = fy/flen, f2 = fz/flen;

  const rx = f1*up[2]-f2*up[1], ry = f2*up[0]-f0*up[2], rz = f0*up[1]-f1*up[0];
  const rlen = Math.hypot(rx, ry, rz);
  const r0 = rx/rlen, r1 = ry/rlen, r2 = rz/rlen;

  const u0 = r1*f2-r2*f1, u1 = r2*f0-r0*f2, u2 = r0*f1-r1*f0;

  const m = new Float32Array(16);
  m[0]=r0;  m[1]=u0;  m[2]=-f0; m[3]=0;
  m[4]=r1;  m[5]=u1;  m[6]=-f1; m[7]=0;
  m[8]=r2;  m[9]=u2;  m[10]=-f2; m[11]=0;
  m[12]=-(r0*eye[0]+r1*eye[1]+r2*eye[2]);
  m[13]=-(u0*eye[0]+u1*eye[1]+u2*eye[2]);
  m[14]= (f0*eye[0]+f1*eye[1]+f2*eye[2]);
  m[15]=1;
  return m;
}
