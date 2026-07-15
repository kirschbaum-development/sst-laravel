@extends('layouts.auth', ['title' => 'Dashboard'])

@section('content')
    <h1>Database interaction works</h1>
    <p>
        Signed in as <strong>{{ auth()->user()->name }}</strong>
        ({{ auth()->user()->email }}). The user and this session are stored in D1.
    </p>

    <div class="row">
        <a href="{{ route('home') }}">Home</a>
        <form method="POST" action="{{ route('logout') }}">
            @csrf
            <button type="submit">Sign out</button>
        </form>
    </div>
@endsection
