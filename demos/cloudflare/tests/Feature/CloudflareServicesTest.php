<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class CloudflareServicesTest extends TestCase
{
    use RefreshDatabase;

    public function test_the_service_check_exercises_the_database_cache_and_filesystem(): void
    {
        Storage::fake('local');

        $this->get('/cloudflare')
            ->assertOk()
            ->assertJson([
                'database' => true,
                'cache' => true,
                'storage' => true,
                'filesystem' => 'local',
            ]);
    }
}
