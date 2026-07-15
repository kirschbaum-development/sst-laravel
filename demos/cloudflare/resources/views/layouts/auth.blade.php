<!DOCTYPE html>
<html lang="{{ str_replace('_', '-', app()->getLocale()) }}">
    <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>{{ $title }} · {{ config('app.name') }}</title>
        <style>
            :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
            * { box-sizing: border-box; }
            body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #f7f7f5; color: #1b1b18; }
            main { width: min(92vw, 28rem); padding: 2rem; border: 1px solid #deded9; border-radius: .75rem; background: white; box-shadow: 0 1rem 3rem rgb(0 0 0 / .08); }
            h1 { margin: 0 0 .4rem; font-size: 1.65rem; }
            p { color: #686864; }
            label { display: block; margin-top: 1rem; font-size: .9rem; font-weight: 600; }
            input[type="text"], input[type="email"], input[type="password"] { width: 100%; margin-top: .4rem; padding: .7rem .8rem; border: 1px solid #c7c7c1; border-radius: .4rem; background: white; color: #1b1b18; }
            button, .button { display: inline-block; margin-top: 1.25rem; padding: .7rem 1rem; border: 0; border-radius: .4rem; background: #f53003; color: white; cursor: pointer; font-weight: 700; text-decoration: none; }
            a { color: #c62603; }
            .error { color: #b42318; margin: .35rem 0 0; font-size: .85rem; }
            .row { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
            .row label { margin-top: 1.25rem; font-weight: 400; }
            .muted { margin-bottom: 0; font-size: .9rem; }
            @media (prefers-color-scheme: dark) {
                body { background: #0a0a0a; color: #ededec; }
                main { background: #161615; border-color: #3e3e3a; }
                p { color: #a1a09a; }
                input[type="text"], input[type="email"], input[type="password"] { background: #222220; border-color: #4b4b46; color: #ededec; }
                a { color: #ff6b4a; }
            }
        </style>
    </head>
    <body>
        <main>
            @yield('content')
        </main>
    </body>
</html>
