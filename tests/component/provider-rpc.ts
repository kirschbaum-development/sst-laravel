/** Calls the binary selected by the installed SST platform; no AWS or Docker daemon needed. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ResourceProviderClient } = require('@pulumi/pulumi/proto/provider_grpc_pb.js');
const { CheckRequest } = require('@pulumi/pulumi/proto/provider_pb.js');
const { Struct } = require('google-protobuf/google/protobuf/struct_pb.js');
const grpc = require('@grpc/grpc-js');

export async function checkImageInputs(inputs: Record<string, unknown>): Promise<Array<{ property: string; reason: string }>> {
  const version = JSON.parse(fs.readFileSync(path.resolve('.sst/platform/package.json'), 'utf8')).dependencies['@pulumi/docker-build'];
  const plugin = `resource-docker-build-v${version}/pulumi-resource-docker-build`;
  const binary = [
    process.env.SST_DOCKER_BUILD_PROVIDER,
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'sst/plugins', plugin),
    path.join(process.env.PULUMI_HOME ?? path.join(os.homedir(), '.pulumi'), 'plugins', plugin),
  ].find((candidate) => candidate && fs.existsSync(candidate));
  if (!binary) throw new Error(`Install the docker-build ${version} Pulumi plugin or set SST_DOCKER_BUILD_PROVIDER to its binary.`);
  const provider = spawn(binary, [], { stdio: ['ignore', 'pipe', 'pipe'] });
  let client: any;
  try {
    const port = await new Promise<string>((resolve, reject) => {
      let buffer = '';
      provider.stdout.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes('\n')) resolve(buffer.split('\n')[0]);
      });
      provider.once('error', reject);
      provider.once('exit', (code) => reject(new Error(`Provider exited before listening: ${code}`)));
    });
    client = new ResourceProviderClient(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const request = new CheckRequest();
    request.setUrn('urn:pulumi:test::sst-laravel::docker-build:index:Image::compatibility');
    request.setNews(Struct.fromJavaScript(inputs));
    const response: any = await new Promise((resolve, reject) => client.check(request, { deadline: Date.now() + 15000 },
      (error: Error, result: unknown) => error ? reject(error) : resolve(result)));
    return response.toObject().failuresList;
  } finally {
    client?.close();
    provider.kill();
  }
}
