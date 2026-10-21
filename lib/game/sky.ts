import * as THREE from 'three'

export const HORIZON_COLOR = '#9ed1f5'

const vertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
}
`

const fragment = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
varying vec3 vDir;

float gridLine(float coord, float width) {
  float f = abs(fract(coord) - 0.5);
  float w = fwidth(coord) * width;
  return 1.0 - smoothstep(0.5 - w, 0.5, f);
}

void main() {
  vec3 d = normalize(vDir);
  float h = d.y;
  vec3 top = vec3(0.04, 0.10, 0.26);
  vec3 mid = vec3(0.13, 0.40, 0.76);
  vec3 hor = vec3(0.62, 0.82, 0.96);
  vec3 col = mix(hor, mid, smoothstep(0.0, 0.32, h));
  col = mix(col, top, smoothstep(0.32, 0.95, h));
  if (h < 0.0) col = mix(hor, vec3(0.45, 0.58, 0.72), smoothstep(0.0, -0.35, h));

  float az = atan(d.z, d.x) / 6.2831853;
  float el = asin(clamp(h, -1.0, 1.0)) / 1.5707963;
  float meridians = gridLine(az * 64.0, 1.2) * (1.0 - smoothstep(0.55, 0.85, el));
  float parallels = gridLine(el * 18.0, 1.2);
  float gridFade = smoothstep(0.01, 0.12, h);
  float grid = max(meridians, parallels) * gridFade;
  col += vec3(0.55, 0.88, 1.0) * grid * 0.16;

  // nodes where lines cross
  vec2 cell = vec2(fract(az * 64.0), fract(el * 18.0));
  float node = step(length(cell - 0.5), 0.12) * gridFade * (1.0 - smoothstep(0.5, 0.8, el));
  float pulse = 0.5 + 0.5 * sin(uTime * 2.0 + floor(az * 64.0) * 1.7 + floor(el * 18.0) * 3.1);
  col += vec3(0.6, 0.95, 1.0) * node * pulse * 0.25;

  // rising scan band
  float bandPos = fract(uTime * 0.04) * 1.3 - 0.1;
  col += vec3(0.35, 0.75, 1.0) * exp(-pow((h - bandPos) * 38.0, 2.0)) * 0.22 * gridFade;

  // scanlines
  col *= 0.965 + 0.035 * sin(gl_FragCoord.y * 1.6 + uTime * 4.0);

  // square, circuit-like sun
  vec3 s = normalize(uSunDir);
  vec3 su = normalize(cross(s, vec3(0.0, 1.0, 0.0)));
  vec3 sv = cross(su, s);
  float fd = dot(d, s);
  if (fd > 0.0) {
    vec2 p = vec2(dot(d, su), dot(d, sv)) / fd;
    float m = max(abs(p.x), abs(p.y));
    float core = step(m, 0.075);
    vec2 c = abs(fract(p / 0.025) - 0.5);
    float inner = step(0.38, max(c.x, c.y)) * core;
    col = mix(col, vec3(1.0, 0.99, 0.92), core);
    col = mix(col, vec3(0.55, 0.85, 1.0), inner * 0.55);
    float halo = step(m, 0.105) * (1.0 - core);
    col = mix(col, vec3(0.85, 0.95, 1.0), halo * 0.35);
    col += vec3(0.5, 0.8, 1.0) * exp(-m * 14.0) * 0.3;
  }

  gl_FragColor = vec4(col, 1.0);
}
`

export function createSky() {
  const material = new THREE.ShaderMaterial({
    vertexShader: vertex,
    fragmentShader: fragment,
    uniforms: {
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.45, 0.62, -0.65).normalize() },
    },
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  })
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(400, 32, 24), material)
  mesh.renderOrder = -10
  mesh.frustumCulled = false
  return { mesh, material }
}
